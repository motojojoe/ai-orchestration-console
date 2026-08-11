# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local, single-user web console that runs a fixed 3-stage pipeline against a project directory on
this machine: **Plan** (Claude Code, headless) → **Execute** (OpenCode, free model) → **Review**
(Claude Code, headless). See [`SPEC.md`](SPEC.md) for the full behavioral spec and
[`docs/wayfinder/`](docs/wayfinder/map.md) for the decision trail it was compiled from — read
`SPEC.md` before changing pipeline behavior; it documents *why* things work the way they do, not
just what the code does.

## PMB workspace routing

Console implementation memory belongs to this repository's PMB workspace even when the console
orchestrates another repository. The target path is runtime input; it does not make console design,
defects, tests, or releases part of the target repository's memory.

Before any other PMB call, use `mcp__pmb__workspace_info` through the same MCP connection that would
read or write memory. Require `name=ai-orchestration-console` and require `root` to equal the
canonical main-worktree root: the parent directory of the absolute common Git directory returned by
`git rev-parse --path-format=absolute --git-common-dir`. A linked worktree must resolve to that same
canonical identity, not to its own checkout path. The reported `id` is machine-local: require it to
remain stable within the session, but do not hardcode it in tracked files. Only after this gate
passes may the session call `prepare`, `recall`, or a PMB write tool. `pmb workspace current` starts
a separate CLI process, so it is useful for resolver diagnostics but never proves the attachment of
an already-running MCP engine. Conversely, before any mutating standalone PMB CLI command, run
`pmb workspace current` from that command's exact working directory and require the intended
name/root; an MCP `workspace_info` result does not attest a separate CLI process.

On a mismatch, error, or unavailable `workspace_info`, make no further PMB calls and do not begin
PMB-dependent substantive work. Immediately tell the user the expected and actual identity (or
that the actual identity is unavailable), the blocked action, and that no PMB write was attempted.
Recover by restarting or reconnecting a session rooted or configured for this repository, exposing
`workspace_info`, and repeating the gate before `prepare`. A shell tool's working directory, an
event's `project` field, and a recall filter do not retarget a running MCP server. Do not use the
persisted global `pmb workspace use` switch while concurrent agents may be active.

If one run produces both console and target-repository knowledge, split it into atomic records:
console implementation context stays here; target code, domain, and task decisions go to the
target repository's independently verified PMB connection.

This repository does not yet have an `AGENTS.md`, so this section governs Claude Code only. Do not
claim that Codex enforces the same fail-closed policy until a canonical Codex-visible agent document
is explicitly approved and added.

## Git workflow

This repo follows **gitflow** — never commit directly to `main`. Do work on a `feature/*` (or
`fix/*`) branch off `develop` and merge back through a PR; `main` only receives merges from
`develop` or release/hotfix branches.

Never commit a resolved machine-local absolute path or generated local identifier. Use a
repo-relative path, derive it at runtime, document an environment variable, or use an explicit
placeholder instead. Portable home-relative paths such as `~/.orchestrator/history.db` and clearly
marked placeholders are allowed; the prohibition is against real personal paths and generated
values that silently mislead another clone, worktree, or CI environment. Secretlint does not catch
this class of mistake, so inspect the staged diff before committing.

### Running more than one agent at a time

**Give each concurrent agent its own git worktree.** A clone has one `HEAD` and one working tree, so
two agents sharing this directory will silently fight over both:

```bash
git worktree add ../aoc-<task> -b <branch> develop   # start
git worktree remove ../aoc-<task>                    # when the branch is merged or abandoned
```

This is not hypothetical. On 2026-08-11 two sessions worked here at once: one committed a toolchain
change on `chore/pin-toolchain`, the other branched `feature/cli` from it and left `HEAD` there. The
first session was a `git push` away from opening a PR that silently contained the other session's
unreviewed commit, because pushing the current `HEAD` no longer meant pushing its own branch.

Two habits make the failure survivable even without worktrees, and are worth keeping regardless:

- **Push and PR by explicit branch name**, never by implicit `HEAD` — `git push origin <branch>` and
  `gh pr create --head <branch>`. Then a moved `HEAD` cannot smuggle commits into your PR.
- **Check `git log --oneline <base>..<branch>` before opening a PR** and confirm every commit listed
  is one you meant to ship.

Avoid `git checkout` in a shared clone while another agent is working — it rewrites files on disk
underneath them. Prefer a worktree, or wait.

## Commands

```bash
npm install      # also wires up the secretlint pre-commit hook via husky
npm run dev      # start the app at http://localhost:3000 (hot-reloads on save)
npm run build    # production build
npm run start    # run a production build
npm run typecheck  # tsc --noEmit — run this after any change, no test suite exists yet
```

No automated test suite exists in this repo. Verification so far has been manual: run the dev
server, start a real pipeline run against a throwaway git repo, and check the result.

**Toolchain is pinned to Node 22 / npm 10.** `.nvmrc`, the `engines` range and `packageManager` in
`package.json`, and `engine-strict=true` in `.npmrc` all agree, and `.npmrc` makes the range a hard
error rather than a warning. This is load-bearing: npm 11 writes `libc` fields into
`package-lock.json` that npm 10 strips back out, so installing under a mismatched npm produces a
60-line lockfile diff that looks like a dependency change but is not. If you need to move to a newer
Node, change all four in the same commit and regenerate the lockfile deliberately.

### Why `overrides` exists in package.json

Every entry is there to patch a **transitive** dependency of `next` that carries a high-severity
advisory. None of them is a preference. They exist because the alternative npm offers is
`npm audit fix --force`, which upgrades to `next@16`, a breaking change — the overrides are how this
repo stays on Next 15 while still getting the patched sub-dependencies.

| Override | What `next@15.5.22` asks for | Why it's overridden |
|---|---|---|
| `postcss ^8.5.25` | `8.4.31` (exact pin) | Four advisories in `postcss <=8.5.22`: XSS via unescaped `</style>` in stringify output (GHSA-qx2v-qp2m-jg93), and three `sourceMappingURL` path-traversal / arbitrary `.map` file reads (GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849, GHSA-fxqj-rqcc-2cmp) |
| `sharp ^0.35.0` | `^0.34.3` | `sharp <0.35.0` inherits libvips CVE-2026-33327, -33328, -35590, -35591 (GHSA-f88m-g3jw-g9cj). The fix only landed in 0.35.0, so this override deliberately resolves **outside** the range `next` declares — that is required, not an oversight |
| `nanoid ^3.3.17` | via `postcss`, which asks `^3.3.16` | `nanoid <3.3.17` can loop forever when a custom generator is called with size 0 (GHSA-2v37-7h3g-55p8). Unlike the two above, this one resolves *inside* the range `postcss` already declares, so it is a low-risk nudge. Practical exposure here was already nil — `postcss` calls `nanoid(6)` from `nanoid/non-secure` for CSS debug ids, never a custom generator — but leaving it unfixed keeps `npm audit` noisy, which is how real findings get missed |

**These are not permanent.** Once `next` ships a release that depends on patched versions itself, each
override becomes dead weight that silently holds a dependency back. To check whether one is still
earning its place: copy `package.json` to a scratch directory, delete the `overrides` block, run
`npm install && npm audit` there, and see what comes back. Do that in a throwaway directory — not in
this repo, where it would rewrite the lockfile.

Config via environment variables:
- `ORCHESTRATOR_DB_PATH` — SQLite file location, defaults to `~/.orchestrator/history.db`.
- `ORCHESTRATOR_OPENCODE_MODEL` — Execute stage's model, defaults to
  `opencode/deepseek-v4-flash-free`.

## Architecture

### The pipeline is a state machine in `src/lib/orchestrator/pipeline.ts`

This is the file to read first. `startRun` → `approveRun` → `runExecuteAndReview` (also entered
directly by `retryExecute`) walks a run through `planning → awaiting_approval → executing →
reviewing → approved | needs_changes → closed_needs_changes`, or `failed`/`cancelled` from any
point. Every status transition goes through `setStatus`, which both writes to SQLite and emits an
SSE event — the DB row is the single source of truth; the frontend never holds state the backend
doesn't already have.

`src/lib/orchestrator/control.ts` and `src/lib/orchestrator/events.ts` are the supporting
machinery: `control.ts` tracks each run's currently-live child process (for cancellation and
per-stage timeouts) and a cancelled-runs flag that `runStage`/`throwIfCancelled` check explicitly
— cancellation is **not** inferred from a process's exit code, because OpenCode exits 0 on SIGTERM
(a "clean" exit in its own eyes). `events.ts` is an in-memory pub-sub the SSE route
(`src/app/api/runs/[id]/events/route.ts`) subscribes to.

**Both of those files stash their module state on `globalThis` instead of a plain module-level
variable — this is load-bearing, not stylistic.** Next.js dev-mode hot-reload can re-evaluate a
file's top level independently per route, so the route that starts a run and the route that later
subscribes to its SSE stream (or tries to cancel it) don't reliably get the same module instance.
A plain `const emitters = new Map()` silently fragments into separate Maps that never see each
other's writes — this was a real, fully-reproduced bug (see git history: "Fix real-time updates
never arriving over SSE"). Any new run-scoped in-memory state needs the same `globalThis` stashing
pattern, or it will intermittently and silently stop working under dev-mode hot-reload.

### CLI invocation: `src/lib/cli/`

`process.ts` is a shared `spawnAndStreamNdjson` helper both CLIs use — it feeds a prompt over
stdin (not argv, to avoid `ARG_MAX` issues with large diffs/plans) and parses stdout as
newline-delimited JSON. `claude.ts` and `opencode.ts` each know their own CLI's flags and event
shapes on top of that:

- Plan runs `claude --print --permission-mode plan ...` — Claude literally cannot write files in
  this mode, so the backend (not Claude) writes `.orchestrator/plan.md` after capturing Plan's
  final `result` event text.
- Review runs with `--allowedTools "Read Grep Glob"` and a **fresh session** — it never resumes
  Plan's session, and is fed the plan text + diff directly in the prompt rather than exploring on
  its own, so its `VERDICT: APPROVE`/`NEEDS_CHANGES` reflects only what's actually written down.
- Execute (`opencode.ts`) runs with `--dangerously-skip-permissions`. This isn't optional: OpenCode
  has no TTY in this context to answer its own tool-permission prompts, so without that flag every
  run just hangs until the stage timeout.

### Git mechanics: `src/lib/git.ts`

Each run gets an isolated **git worktree** (`createRunWorktree`), never an in-place branch
checkout, so the pipeline never disturbs whatever the user has open in an editor. Three things here
are non-obvious and were each the source of a real bug:

- `computeDiff` runs `git add -A` before diffing. Plain `git diff` silently omits brand-new
  untracked files, so a file Execute created from scratch would otherwise be invisible to Review.
- `computeDiff` always diffs against `plan_commit_sha` (stored on the run row), never a moving
  `HEAD` — otherwise a retry's diff would only show the incremental change since the last attempt,
  not the full cumulative diff Review is supposed to check against Acceptance Criteria.
- `commitExecuteChanges` must run (and does, in `pipeline.ts`, right after `computeDiff`) **before**
  a run can reach a terminal state. `removeRunWorktree` deletes the worktree directory outright on
  cleanup — any of Execute's edits that were never committed to the branch are gone, not just
  hidden. This actually happened to a real run before the fix; recovery required re-applying the
  diff text saved in the DB by hand.

No auto-merge, ever (`git.ts` has no merge function) — a reviewed branch is left for the user to
merge through their own normal git workflow.

### Data layer: `src/lib/db.ts`

Uses Node's built-in `node:sqlite` (`DatabaseSync`), not `better-sqlite3` — the native module
failed to compile against this machine's Node version, and the built-in avoids native compilation
entirely. Schema changes go through `addColumnIfMissing` (a minimal `ALTER TABLE` migration
helper) rather than dropping/recreating the table, since real run history needs to survive schema
changes.

### Frontend

`src/components/RunView.tsx` is the only stateful client component of consequence — it holds the
current `Run` row (re-fetched over plain HTTP whenever an SSE `status_change` event arrives, not
computed from SSE payloads directly) plus a per-stage live log built from forwarded `cli_event`
payloads. All three GET route handlers under `src/app/api/` are marked
`dynamic = "force-dynamic"` deliberately — without it, a polling/refetching client can observe a
cached response even after the real underlying state has already changed.

Desktop notifications (`src/lib/notify.ts`) fire on stage failure/timeout and on run completion,
gated on `Notification.permission`, requested once on page load.
