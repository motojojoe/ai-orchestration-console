# AI Orchestration Console — Map

## Destination

A spec for a local, single-user "AI Orchestration Console" web app that lets the user pick a target project directory and run a fixed 3-stage pipeline per task:

**Plan** (Claude Code CLI, headless) → **Execute** (OpenCode CLI, free model) → **Review** (Claude Code CLI, headless)

- Approval gate before the Execute stage — default is auto-approve, but the user can require manual confirmation.
- One pipeline runs at a time (no concurrent runs in v1); past runs are kept as browsable history.
- No auth / multi-user — runs on localhost for personal use only.

## Notes

- Domain: local dev-tooling for orchestrating coding-agent CLIs, not a hosted product.
- Settled architecture (resolved in a single question each during frontier-mapping, not spun into their own tickets):
  - Stack: Next.js (React) + Node.js backend (API routes) — chosen over Flutter Web because the core job is spawning/managing local child processes and streaming their output.
  - The target project must be a git repo; full branch/worktree lifecycle is decided in ticket 09.
  - CLI output streams to the browser via SSE (one-directional; approve/cancel actions go over plain HTTP requests).
  - Run history persists in a local SQLite file (e.g. `~/.orchestrator/history.db`).
- Skills to consult per ticket: `/research` for the OpenCode investigation ticket; `/grilling` + `/domain-modeling` for decision tickets; `/prototype` for UI-shaped tickets.
- The user is comfortable switching to Thai for nuanced/difficult questions — mirror that in ticket sessions if it helps.

## Decisions so far

- [01 — Research: OpenCode CLI headless mode](issues/01-research-opencode-headless.md) — `opencode run [message]` is non-interactive by default; prompt via CLI args (no prompt-file flag); `--format json` streams incrementally; `--model` picks a free model (OpenCode Zen); `--dir` sets cwd; no aggregate diff reporting exists, so the console must compute the diff itself via `git diff` after Execute runs; auth via env var or `opencode auth login`.
- [03 — Claude Code headless invocation design](issues/03-claude-headless-invocation-design.md) — Plan runs `--permission-mode plan` (Claude can't touch files; backend writes the plan file from the captured result); Review runs fresh (never resumes Plan's session), read-only tools, fed the plan + `git diff` directly, and must open its reply with a parseable `VERDICT: APPROVE`/`NEEDS_CHANGES` line. Both stream via `--output-format stream-json --verbose` forwarded over SSE.
- [02 — Plan↔Execute handoff schema](issues/02-plan-execute-handoff-schema.md) — Plan file is plain Markdown (not JSON/YAML) at `.orchestrator/plan.md`, committed as the first commit on the run's git branch; fixed sections are Objective/Context/Steps/Acceptance criteria/Out of scope — Review checks the diff against Acceptance criteria.
- [04 — Approval gate UI](issues/04-approval-gate-ui.md) — Hybrid of the Dashboard and Composer prototype variants: sidebar with run metadata + pipeline stepper + approve/reject/auto-approve actions, main area is one editable card holding the full plan Markdown (edit-then-approve, no per-field editing).
- [05 — Review stage output & UI](issues/05-review-stage-output-ui.md) — Diff + verdict + reasoning shown together, one view. `NEEDS_CHANGES` is a prominent but non-blocking badge. "Retry Execute" re-runs Execute on the same branch with Review's feedback appended, capped at 3 Execute↔Review cycles per run before requiring manual intervention.
- [06 — Error handling & cancellation](issues/06-error-handling-cancellation.md) — 15-min default per-stage timeout; failures/timeouts fire an OS desktop notification (+ in-app record); cancel sends SIGTERM then SIGKILL after 5s; nothing is ever auto-deleted on failure/cancel — branch and history record are kept, marked `failed`/`cancelled`.
- [07 — Credentials/env config](issues/07-credentials-env-config.md) — No credential store in the console; spawned CLI processes inherit whatever auth is already set up on the machine (`opencode auth login`, Claude Code's own login). A pre-flight check confirms each CLI's credential file/env var is present before a run starts, with an actionable error if not.
- [08 — Project selection & validation UI](issues/08-project-selection-ui.md) — Manual absolute-path entry + a persisted recent-projects list (no native/custom folder browser for v1 — browsers can't return real paths anyway). Before a run starts: path must exist, be a git repo, and have a clean working tree — validated upfront with an actionable inline error, not discovered mid-pipeline.
- [09 — Git branch/worktree lifecycle](issues/09-git-branch-worktree-lifecycle.md) — Each run gets its own git worktree (not an in-place checkout) on branch `orchestrator/<run-id>`, so the user's main working directory is never disturbed. No auto-merge on approval — the branch is left for manual merge. The worktree directory (not the branch) is auto-removed once a run reaches any terminal state.
- [10 — Observability (token/cost/duration)](issues/10-observability-cost-duration.md) — Duration tracked for every stage; token/cost recorded only if the CLI itself reports it (never estimated). Stored on the run's SQLite record, surfaced as a per-run summary only for v1 — no cross-run rollup dashboard yet.
- [11 — Success notification](issues/11-success-notification.md) — Desktop notification on completion is on by default (same permission as ticket 06's failure notifications), with verdict-specific wording — "ready to merge" for `APPROVE`, "needs a look" for `NEEDS_CHANGES` — including the run's task title.

## Not yet specified

- Run-history browsing UX: search/filter/re-run of past pipeline runs.
- Whether an automated test-suite run should be inserted between Execute and Review to catch obvious breakage before human review.

## Out of scope

- Supporting CLIs other than Claude Code and OpenCode, or a general multi-CLI abstraction layer — narrowed from an earlier "generic supervisor/dispatcher" framing to this fixed two-CLI pipeline.
- Multi-user access / authentication — single-user localhost tool only.
- Running multiple pipelines concurrently — v1 runs one pipeline at a time.
- Cloud or remote deployment — localhost only.
