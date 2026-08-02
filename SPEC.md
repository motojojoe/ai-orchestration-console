# AI Orchestration Console — Spec

Status: ready for implementation. Compiled from the [wayfinder map](map.md) and its 11 resolved tickets.

## 1. Overview

A local, single-user web app that runs a fixed 3-stage AI pipeline against a chosen project directory:

```
Plan (Claude Code, headless)  →  Execute (OpenCode, free model)  →  Review (Claude Code, headless)
```

- **Plan**: Claude Code researches the codebase and writes a plan — it cannot touch any files.
- **Execute**: OpenCode reads the plan and makes the actual code changes, in an isolated git worktree.
- **Review**: Claude Code reads the plan and the resulting diff, independently, and verdicts it.

Runs one pipeline at a time. No auth, no multi-user, no cloud deployment — this is a personal tool running on `localhost`. Run history is kept indefinitely and browsable.

## 2. Stack & transport

- **Next.js (React) + Node.js** backend (API routes) — chosen over Flutter Web because the core job is spawning/managing local child processes and streaming their output.
- CLI output streams to the browser over **SSE** (one-directional; approve/cancel/retry actions are plain HTTP requests).
- Run history persists in a local **SQLite** file (e.g. `~/.orchestrator/history.db`).

## 3. Pipeline stages

### 3.1 Plan (Claude Code)

- Invocation: `claude --print --permission-mode plan --output-format stream-json --verbose`.
- `--permission-mode plan` guarantees Claude cannot modify any files during planning — this is enforced by Claude Code itself, not by a tool allowlist.
- Fresh session every run.
- The backend captures the final `result` event from the stream and **writes the plan file itself** — Claude never writes it directly (it can't, in plan mode).

### 3.2 Execute (OpenCode)

- Invocation: `opencode run <prompt>` (non-interactive by default — no separate headless flag). The plan file's contents are passed as the prompt (OpenCode has no dedicated "read this file" flag).
- `--format json` for incremental streamed output; `--model provider/model-id` selects a free model (OpenCode Zen, e.g. `opencode/deepseek-v4-flash-free`); `--dir` points it at the run's isolated worktree (§5).
- OpenCode reports no aggregate end-of-run diff or file list (confirmed absent from its public CLI/REST surface) — the backend computes the diff itself via `git diff` after the process exits.
- Auth: inherited from the machine's existing OpenCode login (§7) — not managed by the console.

### 3.3 Review (Claude Code)

- Invocation: `claude --print --output-format stream-json --verbose`, default (non-plan) permission mode, `--allowedTools` restricted to `Read`, `Grep`, `Glob` only — no `Edit`/`Write`/`Bash`.
- Fresh session — **never resumes Plan's session**. Review only sees what's written down (the plan file's content and the `git diff` output, both passed directly in the prompt by the backend), never Plan's internal reasoning. This mirrors normal code-review practice: an independent read guards against rubber-stamping.
- The prompt requires the reply to open with a machine-parseable verdict line: `VERDICT: APPROVE` or `VERDICT: NEEDS_CHANGES`, followed by free-text reasoning. The backend parses this line to drive UI state; the rest is stored and displayed as-is.

### 3.4 Streaming & parsing (all Claude Code stages)

`stream-json` emits NDJSON events. The backend forwards each event over SSE as it arrives, and separately buffers the stream to extract the final `result` event as the stored structured output (plan text, or verdict + reasoning) for history.

## 4. Plan file

- **Format**: plain Markdown, not JSON/YAML — OpenCode only accepts free-text prompts anyway (§3.2), so a structured schema would just get serialized back to text with no benefit. Markdown also renders directly in the approval-gate UI and reads naturally for both Claude and OpenCode.
- **Location**: `.orchestrator/plan.md`, committed as the **first commit on the run's branch** (not a side-channel file in the console's own storage) — it travels with the diff, visible at merge time, and Review reads it straight from the repo.
- **Fixed template**:

```markdown
# <short task title>

## Objective
<one-line goal>

## Context
<relevant background/constraints — why this is being done>

## Steps
1. ...
2. ...

## Acceptance criteria
- <conditions that define "done" — Review checks the diff against this section>

## Out of scope
- <things this run must NOT touch>
```

`Acceptance criteria` is what Review checks the diff against; `Out of scope` bounds what Execute should touch.

## 5. Git branch & worktree lifecycle

- **Naming**: `orchestrator/<run-id>`.
- **Isolation**: each run gets its own **git worktree** (e.g. `<project>/.orchestrator-worktrees/run-<id>/`), never an in-place branch checkout — the user's main working directory is never disturbed, even if they have the project open in an editor concurrently.
- **No auto-merge.** After Review approves, the branch is left for the user to merge through their own normal git workflow; the run is marked complete/approved in history. Auto-approve (§6) controls whether Execute waits for a human before running — it says nothing about merging into the main branch, which is a separate, higher-consequence action (may trigger CI/deploy).
- **Cleanup**: once a run reaches any terminal state (approved, closed with `NEEDS_CHANGES`, failed, or cancelled), the **worktree directory is removed automatically** — nothing is lost, since all commits live on the branch and can be re-checked-out or re-worktreed at any time. The **branch itself is never deleted automatically** (§8).

## 6. Approval gate UI (before Execute runs)

Prototyped as 3 structurally different variants plus a winning hybrid — see [ticket 04](issues/04-approval-gate-ui.md) and its [prototype](issues/04-assets/approval-gate-prototype.html).

**Winning design (hybrid)**:
- **Sidebar**: run metadata (project, branch, Execute model) and a pipeline stepper (Plan done → Execute awaiting approval → Review pending). Sticky actions: auto-approve toggle, "Approve & run Execute", "Reject run".
- **Main area**: a single card holding the full plan Markdown in an **editable text area** — the user can edit the plan directly before approving (edit-then-approve). Whatever's left in the box is what gets written to `.orchestrator/plan.md` and used for Execute. An "● edited" indicator appears once the text diverges from what Claude originally wrote.
- Auto-approve default is **on** — the pipeline runs straight through Plan → Execute without waiting, unless the user has turned the toggle off (globally or for that run).

## 7. Review stage UI

- Shows the `git diff` (unified, red/green) together with the verdict and Claude's reasoning **in one view** — not split across separate panels, not verdict-only. Reuses the approval-gate hybrid's stepper (now showing Review as done/flagged) and card styling.
- `NEEDS_CHANGES` is a **prominent but non-blocking** badge (on the stepper and run header) — it never prevents closing the run as-is. This is a single-user tool, not a team gate; a hard block would fight the auto-approve philosophy.
- **"Retry Execute"** re-invokes Execute **on the same run branch**, appending Review's `NEEDS_CHANGES` reasoning to OpenCode's instructions (not a fresh Plan or a new branch), then runs Review again. **Capped at 3 Execute↔Review cycles per run** — beyond that, the user must intervene manually (edit the plan, close the run despite `NEEDS_CHANGES`, or cancel it).

## 8. Error handling & cancellation

- **Timeout**: each stage has a configurable per-stage timeout, default **15 minutes**. On timeout, the stage is treated as a failure.
- **Notifications**: failures/timeouts fire an **OS-level desktop notification** via the browser Notification API (permission requested on first app load); an in-app banner/history entry is the permanent record regardless of notification permission.
- **Cancellation**: sends **SIGTERM to the running child process, waits up to 5 seconds, then SIGKILL** if it hasn't exited — graceful-first so an in-progress file write (mainly during Execute) isn't torn mid-write, with a forced fallback so a stuck process can't block the UI.
- **Nothing is auto-deleted on failure/cancellation.** The run's git branch and its history record are kept, status set to `failed`/`cancelled`. Deletion is a manual action the user takes later if they want it.

## 9. Credentials

- **No credential store in the console.** Spawned CLI processes inherit whatever auth is already set up on the machine — the same `opencode auth login` / Claude Code login the user already does from a terminal. The console never collects, stores, or displays an API key itself.
- **Pre-flight check**: before starting a run, the console confirms each CLI's credential file/expected env var is present (not a live API call) and shows an actionable error immediately (e.g. "OpenCode isn't authenticated — run `opencode auth login`") rather than letting the user wait out the 15-minute timeout only to discover a missing login.

## 10. Project selection & validation

- **Input**: manual absolute-path text entry, plus a persisted **recent-projects list**. No native or custom folder browser for v1 — a browser can't return a real filesystem path anyway, and a custom server-driven directory walker isn't worth building for a personal tool where the user already knows their own project paths.
- **Validation, checked before a run starts** (not discovered mid-pipeline):
  1. Path exists and is a directory.
  2. It's a git repository.
  3. Working tree is **clean** — no uncommitted/staged changes (required because creating the run's branch from a dirty tree makes it ambiguous whether in-flight edits belong to the new run or the user's own concurrent work).
- Failures surface as an actionable inline error at the project-selection step.

## 11. Observability

- **Duration** is tracked for every stage. **Token/cost** figures are recorded only if the CLI itself reports them (Claude Code's `stream-json` result event carries usage/cost; OpenCode's free-tier output is recorded as whatever it exposes, or left empty — never estimated).
- Stored on the run's SQLite record. Surfaced as a **per-run summary only** for v1 (e.g. "Plan: 12s, 3.2k tokens · Execute: 45s · Review: 8s, 1.1k tokens, $0.02" on the run detail view) — no cross-run rollup dashboard yet.

## 12. Notifications summary

Desktop notifications (browser Notification API, one permission prompt on first load) fire on:
- **Failure/timeout** (§8) — in-app record always kept regardless of permission.
- **Successful completion**, on by default, with verdict-specific wording including the run's task title:
  - `APPROVE` → e.g. "✅ Add rate limiting to the public API — done, ready to merge."
  - `NEEDS_CHANGES` → e.g. "⚠️ Add rate limiting to the public API — Review flagged issues, needs a look."

## 13. Out of scope (v1)

- Supporting CLIs other than Claude Code and OpenCode, or a general multi-CLI abstraction layer.
- Multi-user access / authentication.
- Running multiple pipelines concurrently.
- Cloud or remote deployment.

## 14. Open / deferred (not blocking implementation)

- Run-history browsing UX beyond the basic list (search/filter/re-run of past runs).
- Whether an automated test-suite run should be inserted between Execute and Review to catch obvious breakage before human review.

## 15. Ticket index

| # | Ticket | Decision |
|---|--------|----------|
| 01 | [Research: OpenCode CLI headless mode](issues/01-research-opencode-headless.md) | CLI flags, I/O, auth — see §3.2, §9 |
| 02 | [Plan↔Execute handoff schema](issues/02-plan-execute-handoff-schema.md) | Plan file format & template — §4 |
| 03 | [Claude Code headless invocation design](issues/03-claude-headless-invocation-design.md) | Plan/Review CLI invocation — §3.1, §3.3 |
| 04 | [Approval gate UI](issues/04-approval-gate-ui.md) | Hybrid prototype — §6 |
| 05 | [Review stage output & UI](issues/05-review-stage-output-ui.md) | Diff+verdict view, retry loop — §7 |
| 06 | [Error handling & cancellation](issues/06-error-handling-cancellation.md) | Timeouts, kill signals, no auto-delete — §8 |
| 07 | [Credentials/env config](issues/07-credentials-env-config.md) | Inherited auth, pre-flight check — §9 |
| 08 | [Project selection & validation UI](issues/08-project-selection-ui.md) | Path entry, validation rules — §10 |
| 09 | [Git branch/worktree lifecycle](issues/09-git-branch-worktree-lifecycle.md) | Worktree isolation, no auto-merge — §5 |
| 10 | [Observability](issues/10-observability-cost-duration.md) | Duration/token/cost tracking — §11 |
| 11 | [Success notification](issues/11-success-notification.md) | Notification content — §12 |
