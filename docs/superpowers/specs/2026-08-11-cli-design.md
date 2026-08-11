# CLI for the AI Orchestration Console — Design

Date: 2026-08-11
Status: approved, ready for an implementation plan

## 1. Purpose

Add a terminal interface, `orch`, that runs the same 3-stage pipeline the web console runs.

The CLI and the web console are **peers, not replacements**. They serve different moments:

- **CLI** — firing a task off quickly from a terminal that is already open in the project, and
  watching it run.
- **Web** — inspecting anything wide: the diff, the full plan, a stage's raw log, run history.

Both read and write the same SQLite database (`~/.orchestrator/history.db`, override with
`ORCHESTRATOR_DB_PATH`), so a run started in one is visible and resumable in the other.

## 2. Guiding constraint

**The CLI does not modify `src/lib/**`.** It is a second consumer of the same library the API
routes consume. Every status transition still goes through `pipeline.ts` → `setStatus` → SQLite,
so the two interfaces cannot drift into different behavior. The one exception is additive: a new
`src/cli/notify.ts`, because the existing `src/lib/notify.ts` is browser-only (it calls the DOM
`Notification` API).

This is possible because `src/lib/**` has **zero** Next.js or React imports — all eleven files use
only `node:` builtins.

## 3. Command surface

| Command | Behavior |
| --- | --- |
| `orch run "<task>"` | Runs the full pipeline in the foreground against `cwd`. `--project <path>` overrides the directory. |
| `orch resume <id>` | Re-enters the interactive prompt for a run parked at a human gate. |
| `orch list` | Table of recent runs (id, status, task, created). |
| `orch show <id>` | One run's status, verdict, branch, per-stage duration and cost. |
| `orch cancel <id>` | Cancels a run, including clearing a run left stranded by a dead process. |
| `orch doctor` | Runs `checkCredentials()` — the same pre-flight the web console runs. |

No `--json` flag. The CLI is not built for scripting; adding a machine-readable dump now would
commit us to a stable shape for a 30-column row before anyone has asked for one.

Argument parsing uses `node:util`'s `parseArgs`. No CLI-framework dependency.

## 4. Module layout

```
src/cli/index.ts      shebang, parseArgs, dispatch, exit code, SIGINT handler
src/cli/commands.ts   run / resume / list / show / cancel / doctor
src/cli/render.ts     RunEvent -> a terminal line (pure)
src/cli/prompt.ts     readline questions, and $EDITOR round-trip
src/cli/notify.ts     macOS desktop notification, silent elsewhere
```

`render.ts` is separated because the event payloads it formats (`NdjsonEvent` is
`Record<string, unknown>`) differ between the Claude and OpenCode CLIs, so this is the logic most
likely to grow and to be revised. Keeping it pure — `RunEvent` in, `string` out — also makes it the
one piece testable without spawning a real CLI.

## 5. Run flow

All of this happens inside a single Node process. There is no HTTP and no SSE: the CLI calls
`subscribeRunEvents` directly, in the same process that emits the events.

```
validateProject(projectPath)     -> exit 64 on failure
checkCredentials()               -> exit 64 on failure
createNewRun({ autoApprove: false })
subscribeRunEvents(id, e => process.stdout.write(renderEvent(e)))

await startRun(id)               // returns at awaiting_approval, or at a terminal state
loop:
  run = getRun(id)
  switch (run.status):
    awaiting_approval -> prompt [a]pprove / [e]dit / [r]eject
                         e: write plan_text to a temp file, open $EDITOR, read it back
                         a/e: await approveRun(id, finalText)
                         r:   await rejectRun(id)
    needs_changes     -> print review_reasoning, prompt [r]etry / [c]lose
                         r: await retryExecute(id)   // pipeline enforces the cap of 3
                         c: await closeRun(id)
    terminal          -> print summary, notify, exit
```

Two details drive this shape:

- `startRun`, `approveRun` and `retryExecute` **await to completion**. The API routes have to
  `void` them and let the client follow over SSE, because an HTTP handler cannot stay open for
  minutes. The CLI has no such constraint, so it simply awaits.
- Those functions **never throw** for a pipeline failure. `failRun` catches everything and records
  `status`, `error_message` and `failed_stage` in the database. So after every await the CLI
  re-reads the run with `getRun(id)` and branches on `status` — it never infers success from the
  absence of an exception.

Functions that *do* throw are the guards: `retryExecute` on a run that is not `needs_changes`, or
one that has hit the retry cap; `approveRun` on a run with no worktree. `index.ts` catches these
and prints the message alone, with no stack trace.

`autoApprove` is always passed as `false`, even for a future `--yes` flag. Passing `true` makes
`startRun` chain into `approveRun` internally, which would leave the CLI no point at which to
insert its approval prompt. A `--yes` flag would instead have the CLI auto-answer its own prompt,
keeping the decision in one place.

## 6. Cancellation

`Ctrl-C` installs a SIGINT handler that calls `await cancelRun(id)` and then exits 130.

This works from the CLI where it would not from a second terminal: `control.ts` holds each run's
live `kill` function in an in-memory map, so only the process that spawned the stage can signal it.
The CLI is that process. `cancelRun` marks the run cancelled, then `gracefulStop` sends SIGTERM,
waits 5 seconds, and sends SIGKILL.

A second SIGINT while that 5-second wait is in progress exits immediately without waiting for
cleanup.

## 7. `resume` and stranded runs

`resume` accepts only `awaiting_approval` and `needs_changes`. Both are true parked states: the
pipeline reached them and stopped, and `finalizeTerminal` has not run, so the worktree is still on
disk and `approveRun` / `retryExecute` can pick the run up.

`planning`, `executing` and `reviewing` are rejected. A run sitting in one of those states in the
database has no live process behind it — its owner exited — and the CLI cannot re-attach to a child
process it never spawned. The message directs the user to `orch cancel <id>`, which is the correct
cleanup: `cancelRun` finds an empty controller entry, so `gracefulStop` is a no-op, and the run is
marked cancelled and its worktree removed.

`orch cancel` on a run that is genuinely live in *another* terminal behaves the same way, and that
is a real limitation: the run is marked cancelled in the database and its worktree is removed, but
the child process the other terminal spawned is not signalled and keeps running until its stage
ends. Cancel a foreground run with `Ctrl-C` in the terminal that owns it.

## 8. Exit codes

| Code | Meaning |
| --- | --- |
| `0` | verdict `APPROVE` |
| `1` | `needs_changes` or `closed_needs_changes` — the pipeline ran, the result did not pass |
| `2` | `failed` — a stage errored or timed out |
| `64` | usage error or failed pre-flight; no run was created |
| `130` | `cancelled` (the conventional SIGINT code) |

`1` and `2` are deliberately distinct: one is a verdict, the other is a malfunction.

## 9. Build and install

```
esbuild src/cli/index.ts --bundle --platform=node --format=cjs \
  --outfile=bin/orch.js --banner:js='#!/usr/bin/env node'
```

`--platform=node` leaves `node:` builtins external automatically, and `src/lib/**` pulls in no npm
packages at all, so the output is a single file that runs without `node_modules`.

`package.json` gains `"bin": { "orch": "./bin/orch.js" }` and a `build:cli` script. Local install is
a one-time `npm link`. `bin/` is gitignored — it is a build artifact.

`esbuild` is the only new dependency, and it is a devDependency.

**Install it under npm 10.** The toolchain is pinned to Node 22 / npm 10 across `.nvmrc`, `engines`,
`packageManager` and `engine-strict=true` in `.npmrc`. Installing under npm 11 rewrites
`package-lock.json` with `libc` fields, producing a large diff that looks like a dependency change
but is not.

## 10. Typechecking and tests

No new tsconfig. The existing `tsconfig.json` includes `**/*.ts`, so `npm run typecheck` covers
`src/cli/` as soon as the files exist. esbuild performs no type checking; `tsc` remains the only
thing that does.

One accepted wart: `tsconfig.json` has `"dom"` in `lib`, so a browser global used by mistake in CLI
code would still typecheck. Splitting the tsconfig to close this is not worth the cost.

Testing follows the repository's existing posture — manual verification against a throwaway git
repo — with one addition: `render.ts` gets unit tests under `node --test` (a builtin, no new
dependency), since it is pure and has no process to spawn.

## 11. Notifications

SPEC §12 requires a notification when a run completes. `src/lib/notify.ts` cannot be reused: it is
built on the DOM `Notification` API.

`src/cli/notify.ts` uses `osascript -e 'display notification ...'` on macOS and does nothing on
other platforms. Runs take minutes, so the user will typically have switched away even though the
CLI is in the foreground.

## 12. Explicitly out of scope

- **Detached runs / a daemon.** `orch run` blocks. Backgrounding a run would require a log sink and
  PID tracking, and would not help the stated use — starting a task and watching it.
- **Cross-process `cancel` of a live stage.** Covered by the stranded-run path in §7 instead.
- **Merging.** The CLI prints the branch name; merging stays the user's own git workflow, matching
  the web console and `git.ts`, which has no merge function by design.
