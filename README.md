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
