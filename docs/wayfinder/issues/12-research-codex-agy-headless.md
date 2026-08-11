Type: research
Status: resolved

## Question

How do the Codex CLI and the Antigravity CLI (`agy`) support headless/non-interactive execution, and how do
they compare to Claude Code and OpenCode on the points this pipeline depends on?

Specifically:
- What flag(s) run each non-interactively (analogous to Claude Code's `-p` and `opencode run`)?
- How does each accept its instructions — a prompt string, a file path, stdin?
- What output formats are available, and is progress streamed incrementally?
- How is a model selected, and are free/cheap models reachable?
- How is the target working directory specified?
- Can each be run genuinely read-only, and is that enforced rather than merely requested? (Plan and Review
  both require this today via Claude Code's `--permission-mode plan` / `--allowedTools`.)
- What does each report about what it changed, and what do its exit codes mean?
- What usage/cost figures does each report, given SPEC.md §11 records those only when the CLI reports them?
- What auth/config setup is required before headless execution?

This is background research only. It does not propose changing SPEC.md §13, which keeps a general multi-CLI
abstraction layer out of scope for v1.

## Answer

Full findings with citations: [12-research-codex-agy-headless-findings.md](12-research-codex-agy-headless-findings.md)

Researched on 2026-08-11 by exercising both binaries directly (codex-cli 0.147.0, agy 1.1.11) rather than by
reading published source as in ticket 01. Every behavioural claim comes from `--help` output or a recorded
probe run.

Summary:

1. **Headless invocation**: Codex uses a subcommand, `codex exec [PROMPT]` (alias `codex e`). Antigravity uses
   `agy --print "<prompt>"` / `-p`. Codex also has dedicated `codex review` and `codex exec review`
   subcommands — unprobed, but directly suggestive for a Review stage.
2. **Input**: **Codex accepts stdin; Antigravity does not.** Codex takes the prompt positionally, as `-`, or
   piped, appending piped stdin to an argv prompt as a `<stdin>` block. Antigravity takes the prompt *only* as
   the value of `--print`, ignores stdin, and errors on an empty value — so its prompts are bounded by
   `ARG_MAX` (1,048,576 bytes here). That conflicts with `src/lib/cli/process.ts`, which feeds prompts over
   stdin specifically to avoid `ARG_MAX`. Related footgun: `--print` takes the prompt as its *value*, so
   `agy -p --output-format json "…"` silently uses `--output-format` as the prompt.
3. **Output**: both stream NDJSON, but with **different envelopes and neither matching Claude Code's**. Codex
   keys on `type` (`thread.started` → `turn.started` → `item.completed` → `turn.completed`), with the final
   text in an `item.completed` whose `item.type` is `agent_message`. Antigravity keys on `event`
   (`init` → `step_update` → `result`). Antigravity does **not** stream assistant text incrementally — step
   states stream, but the response text arrives only in the terminal `result` event.
4. **Model selection**: Codex `-m/--model`, plus `--oss` + `--local-provider {lmstudio|ollama}` for local
   models (its only free route). Antigravity `--model` plus an `--effort {low|medium|high}` dial, over a fixed
   list from `agy models` (Gemini 3.x, Claude Sonnet/Opus 4.6, GPT-OSS 120B); whether any is free is not
   confirmed.
5. **Working directory**: Codex has `-C/--cd`. **Antigravity has no directory flag** — it uses the process
   cwd, and additionally gates on a `trustedWorkspaces` list in its settings file. Whether `--add-dir` alone
   can make an arbitrary new path writable is **unresolved**, and is the key open question for pointing
   Antigravity at per-run ephemeral worktrees.
6. **Read-only enforcement**: **both verified to genuinely block a write**, by different mechanisms. Codex
   `-s read-only` is an OS-level sandbox — instructed to create a file, the agent tried and reported "the
   workspace is mounted read-only, and write approval is disabled". Antigravity `--mode plan` also wrote
   nothing into the workspace, but it is not globally read-only: it writes a real `implementation_plan.md`
   into its own `~/.gemini/antigravity-cli/brain/<conversation_id>/` directory, at a path derivable from the
   `conversation_id` in every stream event.
7. **Change reporting**: neither emits an aggregate diff or changed-file manifest, so this project's existing
   "compute the diff ourselves via `git diff`" decision holds unchanged. **Antigravity has an exit-code
   trap**: a run whose tool was auto-denied for lack of an allow-rule still returns exit `0` with
   `status: "SUCCESS"` and an empty `response` — a caller must check `response` is non-empty, not just the
   status. Same root cause as OpenCode's `--dangerously-skip-permissions` requirement: no TTY to answer a
   permission prompt.
8. **Usage/cost**: both report token counts, **neither reports cost**. Codex gives five counters on
   `turn.completed` (including `reasoning_output_tokens`); Antigravity gives five on `result.usage` (including
   `thinking_tokens`) plus `duration_seconds` and `num_turns`. No two of the three CLIs' counter sets line up
   field-for-field, so a schema covering all of them needs a superset or a per-CLI blob.
9. **Auth**: both inherit machine-level login, consistent with ticket 07 — no key is passed at invocation.
   Codex keeps OAuth tokens in `~/.codex/auth.json` and ships `codex doctor` as a ready-made pre-flight check.
   Antigravity's settings live at `~/.gemini/antigravity-cli/settings.json` (`permissions.allow`,
   `trustedWorkspaces`) and it has no `doctor` equivalent; its token storage was deliberately not
   investigated.

Two open gaps this research did not resolve, both about Antigravity: whether `--add-dir` can grant an
untrusted directory without a prior `trustedWorkspaces` entry (5), and whether any of its models is free (4).
Codex's `review` subcommands were also left unprobed (1).

Net read: **Codex fits the existing pipeline machinery with no changes to how prompts are passed** — stdin,
an enforced read-only sandbox, and a JSONL stream are all already what the console expects. **Antigravity does
not fit as cleanly**: argv-only prompts collide with the deliberate stdin design, the missing directory flag
plus workspace-trust gate collide with ephemeral worktrees, and its silent-success failure mode needs explicit
handling. None of that is a recommendation to adopt either — SPEC.md §13 still holds.
