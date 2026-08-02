Type: research
Status: resolved

## Question

How does the OpenCode CLI support headless/non-interactive execution?

Specifically:
- What flag(s) run it non-interactively against a task/instruction (analogous to Claude Code's `-p`)?
- How does it accept its instructions — a prompt string, a file path, stdin?
- What output format(s) are available (plain text, streaming JSON, etc.), and can progress be streamed incrementally rather than only returned at the end?
- How is the free-tier/free model selected via CLI flags or config?
- How is the target working directory specified?
- What does it report about what it changed (exit code, file list, diff) — or does the caller need to compute that separately via `git diff`?
- Any auth/config setup required before it can run headlessly (API keys, config files)?

## Answer

Full findings with source citations: [01-research-opencode-headless-findings.md](01-research-opencode-headless-findings.md)

Summary:
1. **Headless invocation**: `opencode run [message..]` — non-interactive is the default mode of this subcommand, no separate headless flag needed. (`opencode serve` / `opencode web` are unrelated standalone server commands.)
2. **Input**: positional CLI args for the prompt text, `--command` for slash-commands, `--file`/`-f` for attachments, plus stdin piping. No dedicated "prompt file" flag — a plan/instruction file would need to be read into the prompt string (or referenced by path within it) by our backend.
3. **Output**: `--format {default|json}`, both streamed incrementally (NDJSON-style events in JSON mode), not buffered to the end — suits our SSE-forwarding plan.
4. **Model selection**: `--model`/`-m provider/model-id` (also settable in `opencode.json`). "OpenCode Zen" (`opencode/<model-id>`) lists explicit free models (e.g. Big Pickle, DeepSeek V4 Flash Free) usable via this flag; Ollama/NVIDIA build.nvidia.com are other free-model routes.
5. **Working directory**: `--dir` flag; falls back to `process.cwd()`/`PWD` if omitted.
6. **Change reporting**: exit code 0/1 only. No aggregate end-of-run diff or file-list surface confirmed — per-edit unified diffs stream live as each edit happens, but there's no confirmed public "give me everything you changed" call. **We should plan on computing the diff ourselves via `git diff` after the run**, not rely on OpenCode to report it.
7. **Auth**: provider API-key env var (auto-detected, fully non-interactive) or interactive `opencode auth login` for OAuth-only providers. Credentials cache at `~/.local/share/opencode/auth.json`.

One open gap the research couldn't resolve from primary sources: whether OpenCode's internal git-backed Snapshot/checkpoint service exposes an aggregate diff via any public CLI/REST surface. Given (6) above, we shouldn't depend on it — decided to use `git diff` regardless.
