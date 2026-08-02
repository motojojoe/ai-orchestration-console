# AI Orchestration Console

A local, single-user web console that runs a fixed 3-stage pipeline against a project of your choosing:

**Plan** (Claude Code, headless) → **Execute** (OpenCode, free model) → **Review** (Claude Code, headless)

Not implemented yet — this repo currently holds the spec and the planning trail it came from.

- [`SPEC.md`](SPEC.md) — the implementation spec.
- [`docs/wayfinder/`](docs/wayfinder/map.md) — the [wayfinder](https://github.com/anthropics/claude-code) map and tickets the spec was compiled from, including the approval-gate UI prototype.
