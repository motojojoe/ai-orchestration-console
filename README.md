# AI Orchestration Console

A local, single-user web console that runs a fixed 3-stage pipeline against a project of your choosing:

**Plan** (Claude Code, headless) → **Execute** (OpenCode, free model) → **Review** (Claude Code, headless)

- [`SPEC.md`](SPEC.md) — the implementation spec.
- [`docs/wayfinder/`](docs/wayfinder/map.md) — the [wayfinder](https://github.com/anthropics/claude-code) map and tickets the spec was compiled from, including the approval-gate UI prototype.

## Requirements

- Node.js with `node:sqlite` available (used instead of a native SQLite dependency).
- The `claude` CLI, authenticated (`claude auth status`).
- The `opencode` CLI, authenticated (`opencode auth list`).
- Target projects must be local git repositories with a clean working tree.

## Running it

```bash
npm install
npm run dev
```

Open http://localhost:3000, point it at a project path on this machine, describe a task, and start a run.

Run history lives in `~/.orchestrator/history.db` (override with `ORCHESTRATOR_DB_PATH`). The Execute model
defaults to `opencode/deepseek-v4-flash-free` (override with `ORCHESTRATOR_OPENCODE_MODEL`).

## The `orch` CLI

Same pipeline, same database, from a terminal:

```bash
npm run build:cli && npm link      # once
cd ~/some/project
orch run "add a health check endpoint"
```

`orch run` blocks until the run reaches a terminal state, streaming each stage and prompting at
the two human gates: approve/edit/reject the plan, then retry/close if Review flags changes.
Editing opens `$VISUAL` or `$EDITOR` — neither set is an error, never a guess at `vi`. `Ctrl-C`
cancels the run and cleans up its worktree; a second `Ctrl-C` forces the exit without waiting.

| Command | |
| --- | --- |
| `orch run "<task>" [--project <path>]` | run the pipeline, defaulting to the current directory |
| `orch resume <id>` | re-enter a run parked at a gate |
| `orch list` / `orch show <id>` | recent runs / one run in detail |
| `orch cancel <id>` | cancel a parked run, or clear one stranded by a dead process |
| `orch doctor` | check that `claude` and `opencode` are authenticated |

Exit codes: `0` approved, `1` finished without approval, `2` a stage failed, `64` usage or
pre-flight error, `130` interrupted. Rejecting a plan at the gate also exits `130` — rejecting
records the run as `cancelled`, and the exit code follows the recorded status rather than the
gesture that produced it.

`orch resume` exists for runs **this** terminal is not holding: one started in the web console, or
one orphaned when its process was killed outright. It is not an undo for `Ctrl-C` — interrupting a
run cancels it, so there is nothing left to resume. `orch list` prints the 20 most recent runs of
every status without marking any of them; the resumable ones are those listed as
`awaiting_approval` or `needs_changes`.

The live stage log belongs to whichever process owns the run — the web console cannot show the log
of a CLI run, and vice versa. Everything persisted (plan, diff, verdict, cost) is visible in both.
`orch run` refuses to start a second pipeline while one is unfinished, and names the remedy: answer
the prompt in the terminal that owns it, or `orch cancel <id>` if nothing does. That check is the
CLI's alone — the web console starts a run without it, so nothing stops a browser tab from starting
a second pipeline alongside a CLI one.
