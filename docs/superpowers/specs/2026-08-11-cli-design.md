# CLI for the AI Orchestration Console — Design

Date: 2026-08-11
Status: revised after a cross-model review; ready for an implementation plan

Revision note: the first draft of this document claimed the CLI would not need to touch
`src/lib/**`. A review by Codex CLI, with every finding re-verified against the source, showed that
constraint was incompatible with two things the same document promised. Two pre-existing library
bugs are now in scope (§9). The rest of that review's findings are folded in throughout.

## 1. Purpose

Add a terminal interface, `orch`, that runs the same 3-stage pipeline the web console runs.

The CLI and the web console are **peers, not replacements**:

- **CLI** — firing a task off from a terminal already open in the project, and watching it run.
- **Web** — inspecting what is persisted: the diff, the final plan, the verdict and reasoning,
  per-stage cost and duration, and run history.

Both read and write the same SQLite database (`~/.orchestrator/history.db`, override with
`ORCHESTRATOR_DB_PATH`), so a run started in one is visible and resumable in the other.

**One thing does not cross that boundary: the live stage log.** `RunView.tsx` filters CLI events
through `formatCliEvent` and holds the result in React state; the schema in `db.ts` has no
event or log column. So the log is lost on refresh, is absent when a page is opened after the fact,
and is invisible for a run another process owns. The same is true in reverse — the CLI cannot show
the log of a web-owned run. Whoever owns a run sees its log; nobody else ever does, in either
direction. Persisting events is out of scope here (§12).

## 2. What is reusable, and what is not

`src/lib/**` has **zero Next.js or React imports** — that is what makes the CLI a second consumer
rather than a rewrite.

The narrower claim that those files use only `node:` builtins is false: `src/lib/notify.ts` is
built on the DOM `Notification` API and browser `window`. It is the one library file the CLI
cannot reuse.

## 3. Command surface

| Command | Behavior |
| --- | --- |
| `orch run "<task>"` | Runs the full pipeline in the foreground against `cwd`. `--project <path>` overrides the directory. |
| `orch resume <id>` | Re-enters the interactive prompt for a run parked at a human gate. |
| `orch list` | Table of recent runs (id, status, task, created). |
| `orch show <id>` | One run's status, verdict, branch, per-stage duration and cost. |
| `orch cancel <id>` | Cancels a parked run, or clears a run stranded by a dead owner. Refuses a run a live process owns (§7). |
| `orch doctor` | Runs `checkCredentials()` — the same pre-flight the web console runs. |

No `--json` flag. The CLI is not built for scripting; committing to a stable machine-readable shape
for a 30-column row before anyone has asked for one is a cost with no current benefit.

Argument parsing uses `node:util`'s `parseArgs`. No CLI-framework dependency.

## 4. Module layout

```
src/cli/index.ts      shebang-free entry: parseArgs, dispatch, exit code, signal handling
src/cli/commands.ts   run / resume / list / show / cancel / doctor
src/cli/render.ts     RunEvent -> a terminal line (pure; type-only imports)
src/cli/prompt.ts     readline questions, and the $EDITOR round-trip
src/cli/notify.ts     macOS desktop notification, silent elsewhere
```

`render.ts` is separated because the payloads it formats (`NdjsonEvent` is
`Record<string, unknown>`) differ between the Claude and OpenCode CLIs, so it is the logic most
likely to grow and be revised. It must import **types only** — see §11 for why that is load-bearing
for its tests.

## 5. Run flow

All of this happens inside a single Node process. There is no HTTP and no SSE: the CLI calls
`subscribeRunEvents` directly, in the process that emits the events.

```
validateProject(projectPath)     -> exit 64 on failure
checkCredentials()               -> exit 64 on failure
assertNoActiveRun()              -> exit 64 if another run is live (§8)
createNewRun({ autoApprove: false })
unsubscribe = subscribeRunEvents(id, e => process.stdout.write(renderEvent(e)))
try {
  await startRun(id)             // returns at awaiting_approval, or at a terminal state
  loop:
    run = getRun(id)
    switch (run.status):
      awaiting_approval -> prompt [a]pprove / [e]dit / [r]eject
                           e: $EDITOR round-trip (§6)
                           a/e: await approveRun(id, finalText)
                           r:   await rejectRun(id)
      needs_changes     -> print review_reasoning, prompt [r]etry / [c]lose
                           r: await retryExecute(id)
                           c: await closeRun(id)
      terminal          -> print summary, notify, exit
} finally {
  unsubscribe()                  // required — see below
}
```

Three properties of `pipeline.ts` shape this:

- `startRun`, `approveRun` and `retryExecute` **await to completion**. The API routes `void` them
  only because an HTTP handler cannot stay open for minutes. The CLI has no such constraint.
- They **do not throw for a stage failure**: `failRun` records `status`, `error_message` and
  `failed_stage` in the database instead. So after every await the CLI re-reads the run with
  `getRun(id)` and branches on `status`, never inferring success from the absence of an exception.
- They **do throw** for other reasons, and the list is longer than a guard list:
  `startRun`/`rejectRun`/`closeRun`/`cancelRun` throw on an unknown id; `retryExecute` throws on a
  wrong status or a hit retry cap; `approveRun` throws on a missing worktree — and, until the fix
  in §9, also on a git failure during the plan commit. Every one of these must set a non-zero
  `process.exitCode`; printing a message and falling through would exit 0.

`unsubscribe()` in `finally` is not optional hygiene. Listeners registered with
`subscribeRunEvents` stay reachable through the `globalThis` emitter map for the life of the
process. (Verified: a bare `EventEmitter` listener adds no active libuv handle, so this cannot hang
the process — it is a retention leak only. The emitter entry itself is never removed from the map
even after the last listener goes; that is pre-existing and left alone.)

`autoApprove` is always passed as `false`, even for a future `--yes` flag. Passing `true` makes
`startRun` chain into `approveRun` internally, leaving the CLI no point at which to insert its
prompt. `--yes` would instead have the CLI auto-answer its own prompt.

## 6. The `$EDITOR` contract

The web route trims the submitted plan and falls back to the stored one when it is empty. The CLI
calls `approveRun` directly, which accepts any string and commits it, so without an equivalent
contract the CLI would commit an empty `.orchestrator/plan.md` where the web console would not.

| Case | Behavior |
| --- | --- |
| Neither `$VISUAL` nor `$EDITOR` set | Refuse the `[e]dit` choice, print how to set it, re-prompt. Do not guess `vi`. |
| Value contains arguments (`code --wait`) | Split on whitespace, first token is the program, rest are argv. No shell — avoids quoting and injection. |
| Editor fails to spawn, or exits non-zero | Keep the original plan text, report it, re-prompt. Never approve a partial edit. |
| Saved file is empty or whitespace | Refuse; re-prompt. Matches the web fallback rather than diverging from it. |
| SIGINT arrives while the temp file exists | The signal path (§7) removes it. |

The temp file is created under the scratch directory with mode `0600` and removed in a `finally`.

## 7. Cancellation and signals

**`Ctrl-C` during a run.** A naive `await cancelRun(id); process.exit(130)` loses a race.
`gracefulStop` sends SIGTERM, waits a fixed five seconds, sends SIGKILL — and never awaits the
child's `close` event or the pipeline promise. Exiting right after it returns can beat the
`cancelled` status write and `finalizeTerminal`'s worktree removal, stranding exactly the state the
cancel was supposed to clean up. Worse, if cancel lands in a gap where no stage is registered,
`gracefulStop` returns instantly and the immediate exit is nearly guaranteed to strand the run.

So the handler is:

```
let cancelling = false
on SIGINT:
  if cancelling: process.exit(130)          // second Ctrl-C is the escape hatch
  cancelling = true
  print "cancelling — Ctrl-C again to force"
  await cancelRun(id)
  await pipelinePromise                     // the in-flight startRun/approveRun/retryExecute
  cleanup temp files, unsubscribe
  process.exit(130)
```

with a bounded fallback timer (30s) that force-exits if the pipeline promise never settles. This
requires `commands.ts` to keep a reference to the outstanding pipeline promise, which the flow in
§5 already has in hand.

**`orch cancel <id>`.** Three cases, distinguished by the `owner_pid` column added in §9:

| Case | Behavior |
| --- | --- |
| Parked (`awaiting_approval`, `needs_changes`) | `cancelRun` marks it cancelled and removes the worktree. Works today. |
| Active status, owner process dead | Stranded. Cleared by the `cancelRun` fix in §9. |
| Active status, owner process alive | Refuse. Tell the user to `Ctrl-C` in the terminal that owns it. |

The third case is a deliberate refusal, not a limitation to route around: another process has a
child mid-write in that worktree, and `finalizeTerminal` deletes worktrees outright. Removing one
under a live Execute would destroy uncommitted work — the same class of failure the
`commitExecuteChanges` fix in `git.ts` was written to prevent.

## 8. Concurrency

`SPEC.md:17` states the tool "runs one pipeline at a time", and §13 lists concurrent pipelines as a
non-goal. **Nothing in the code enforces this.** The web POST route validates, creates and starts a
run without checking for another active one. That is pre-existing, and adding a second interface
makes it easier to hit.

What is in scope:

- A `findActiveRun()` helper in `db.ts`, and an `assertNoActiveRun()` check in the CLI's `run`
  command that refuses to start when another run is active *and* its `owner_pid` is alive. A run
  whose owner is dead is reported as stranded, with the `orch cancel <id>` remedy.
- `PRAGMA busy_timeout = 5000` in `getDb()`. Node's `node:sqlite` defaults to a busy timeout of
  zero (verified on the pinned 22.23.1 runtime), so two processes writing at once can raise
  `SQLITE_BUSY` immediately rather than waiting. This is one line and it benefits the web app too.

What is **not** in scope: a real lease. The web route remains unguarded, and the CLI's check is
advisory — two `orch run` invocations racing between the check and `createRun` can both proceed.
Closing that needs compare-and-set status transitions in `updateRun` and a guard on the web route,
which is a separate piece of work with its own risk to existing behavior. This document does not
claim to satisfy `SPEC.md:17`; it narrows the window and makes the violation detectable.

Also unguarded, and worth knowing about rather than papering over: `approveRun` has no status
check, and `retryExecute`'s read-check-increment of `retry_count` is not atomic. Two actors on the
same parked run can double-approve or lose a retry increment.

## 9. Library changes (`src/lib/**`)

Two pre-existing bugs. Both affect the web console today; neither was introduced by the CLI, and
both must be fixed for the CLI's documented behavior to be true.

**1. `cancelRun` cannot clear a stranded run** — `pipeline.ts:247`

```ts
if (run.status === "planning" || run.status === "executing" || run.status === "reviewing") {
  await gracefulStop(runId);
  return;                        // <- returns here
}
setStatus(runId, "cancelled");   // <- never reached
await finalizeTerminal(getRun(runId)!);
```

A stranded run's status is one of those three, so cancel enters the first branch; `gracefulStop`
finds no controller and returns immediately; `cancelRun` returns. The run stays `executing` and its
worktree stays on disk forever.

The fix needs to tell a dead owner from a live one, so:

- Add an `owner_pid INTEGER` column via `addColumnIfMissing` (the repo's established migration
  path — real history must survive).
- `startRun` writes `process.pid`; `finalizeTerminal` clears it.
- Export `hasLiveStage(runId)` from `control.ts`.
- `cancelRun` becomes: live stage in **this** process → `gracefulStop` and return, letting the
  owning promise reach `failRun`. No local stage and `owner_pid` alive (`process.kill(pid, 0)`,
  treating `EPERM` as alive) → throw, so the caller can print the "Ctrl-C in the owning terminal"
  message. Otherwise → fall through to `setStatus(cancelled)` + `finalizeTerminal`.

PID reuse could in principle make a dead owner look alive. For a single-user local tool the
consequence is a refusal the user can work around, not data loss, so it is accepted rather than
solved with a pid+start-time pair.

Note also that `markCancelled` only adds to a process-local `Set` — it does not write to SQLite.
The database reaches `cancelled` only when the owning pipeline observes the flag and reaches
`failRun`. No change; it just must not be described otherwise.

**2. `approveRun` lets git failures escape** — `pipeline.ts:132`

```ts
const planCommitSha = await writePlanFileAndCommit(run.worktree_path, finalPlanText);
```

`runGit` throws on any git failure, and this call sits outside any `try`/`catch`, so the error
propagates out of `approveRun`, bypasses `failRun`, and leaves the run at `awaiting_approval` with
a live worktree and nothing recorded. The existing API route's "crashed outside its own error
handling" catch is an acknowledgement of this hole, not a fix for it.

Wrap the plan write and commit in the same `try`/`catch` the rest of the pipeline uses, routing
failures to `failRun(runId, "plan", err)`.

**Not being fixed here:** the retry cap is off by one. `retry_count` starts at 0 and
`retryExecute` rejects only at `>= 3`, permitting the initial cycle plus three retries — four
Execute↔Review cycles, where `SPEC.md:99` and the button tooltip in `RunView.tsx:393` both say
three. It is a real inconsistency, it predates this work, and fixing it changes web behavior for
reasons unrelated to the CLI. Filed as a follow-up, not bundled.

## 10. Exit codes

| Code | Meaning |
| --- | --- |
| `0` | verdict `APPROVE`; or any non-`run` command that succeeded (`list`, `show`, `cancel`, `doctor`) |
| `1` | the run finished without approval — `closed_needs_changes`, or rejected at the approval gate |
| `2` | `failed` — a stage errored or timed out |
| `64` | usage or pre-flight error, and every thrown guard: unknown id, un-resumable status, retry cap reached, no `$EDITOR`, another run already active |
| `130` | terminated by `Ctrl-C`, and only that |

Two corrections against the first draft. `needs_changes` gets no code of its own: it is not in
`TERMINAL_STATUSES`, and the flow in §5 always resolves it to a retry or a close first. And `130`
no longer covers rejecting a plan or a successful `orch cancel` — those are commands that did what
they were asked, and conflating them with signal termination makes the code useless to a caller.

Every path that catches an error to print it must also set `process.exitCode`.

## 11. Build, install, typecheck, tests

```
esbuild src/cli/index.ts --bundle --platform=node --format=cjs --target=node22 \
  --outfile=bin/orch.js --banner:js='#!/usr/bin/env -S node --no-warnings'
```

- **One shebang, not two.** `index.ts` must not carry its own. esbuild preserves an input hashbang
  ahead of banner text, which would put a second `#!` on line 2 and make the file a syntax error.
  The banner is the single source.
- `--target=node22` is required. `--platform=node` changes resolution and externalizes builtins but
  does not constrain emitted syntax.
- `--no-warnings` in the shebang suppresses `ExperimentalWarning: SQLite is an experimental
  feature`, which `node:sqlite` emits on every startup and would otherwise precede the output of
  every command. (`env -S` for multi-argument shebangs works on macOS, the only supported platform.)
- **No top-level `await` in `index.ts`.** esbuild only supports bundled top-level await for ESM
  output; with `--format=cjs` the entry must be an `async main()` whose rejection sets
  `process.exitCode`.
- `--platform=node` leaves `node:` builtins external, and `src/lib/**` pulls in no npm packages, so
  the output is a single file that runs without `node_modules`.

**Install lifecycle.** `package.json` gains `"bin": { "orch": "./bin/orch.js" }` and a `build:cli`
script. `npm link` does **not** build — the existing `prepare` hook runs only Husky. The documented
install is `npm run build:cli && npm link`.

**`.gitignore` must gain `bin/`.** It currently ends at the SQLite sidecar patterns, so the bundle
would show up as an untracked file on the first build. This is an implementation task, not an
existing fact.

**`engines`.** `package.json` declares `"node": ">=22 <23"`, but `db.ts` imports `node:sqlite`
unconditionally and that module landed in 22.5.0. The floor should be `>=22.5`. Per CLAUDE.md the
toolchain pins are load-bearing and change deliberately — this goes in its own commit, and does not
touch the npm pin or the lockfile.

**Typecheck** needs no new tsconfig: `tsconfig.json` includes `**/*.ts`, so `npm run typecheck`
covers `src/cli/` as soon as the files exist. esbuild does no type checking; `tsc` stays the only
thing that does. Accepted wart: `lib` includes `"dom"`, so a browser global used by mistake in CLI
code would still typecheck. Splitting the tsconfig is not worth the cost.

**Tests.** `package.json` has no `test` script; add one:
`node --experimental-strip-types --test src/cli/*.test.ts`.

This works only because `render.ts` imports **types only**. Node does not read
`moduleResolution: "bundler"` and cannot resolve the extensionless specifiers the rest of
`src/lib/**` uses (`import { ... } from "./process"`), but `import type` is erased entirely, so a
type-only module has nothing left to resolve. That constraint is the reason §4 states it as a rule
rather than an observation.

Beyond `render.ts`, the review was right that pure rendering is not where the risk is. Also tested,
with injected fakes and no real CLI spawned: status-to-exit-code mapping, the `$EDITOR` outcome
table in §6, and the signal handler's second-SIGINT path. Anything needing a real pipeline stays
manual, matching the repository's existing posture.

## 12. Explicitly out of scope

- **Persisting stage events/logs to the database.** This is what would make web and CLI true peers
  for live runs (§1). It is a schema change plus a write on every event, and it is not required for
  either interface to do its own job.
- **A real one-pipeline lease** (§8): compare-and-set transitions in `updateRun` plus a guard on
  the web POST route.
- **Fixing the retry-cap off-by-one** (§9).
- **Detached runs / a daemon.** `orch run` blocks. Backgrounding needs a log sink and PID tracking
  and does not serve the stated use.
- **Merging.** The CLI prints the branch name; merging stays the user's own git workflow, matching
  the web console and `git.ts`, which has no merge function by design.
