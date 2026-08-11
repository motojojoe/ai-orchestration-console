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
2. **Input**: **both accept the prompt on stdin.** Codex takes it positionally, as `-`, or piped, appending
   piped stdin to an argv prompt as a `<stdin>` block. Antigravity's stdin path works only when `--print` is
   omitted *entirely* (`… | agy --output-format json`); passing `-p -` uses the literal `-` as the prompt and
   `-p ""` is a hard error. Either CLI can therefore be fed large prompts the way `src/lib/cli/process.ts`
   already does, with no `ARG_MAX` ceiling to design around. Related footgun: `--print` takes the prompt as
   its *value*, so `agy -p --output-format json "…"` silently uses `--output-format` as the prompt.
3. **Output**: both stream NDJSON, but with **different envelopes and neither matching Claude Code's**. Codex
   keys on `type` (`thread.started` → `turn.started` → `item.completed` → `turn.completed`), with the final
   text in an `item.completed` whose `item.type` is `agent_message`. Antigravity keys on `event`
   (`init` → `step_update` → `result`), and streams assistant text via a `text_delta` field on `step_update`
   events whose `step_type` is `agent_response` — a consumer must accumulate those. Chunking is coarse: a
   40-line answer arrived in two deltas, so token-level granularity should not be assumed.
4. **Model selection**: Codex `-m/--model`, plus `--oss` + `--local-provider {lmstudio|ollama}` for local
   models (its only free route). Antigravity `--model` plus an `--effort {low|medium|high}` dial, over a fixed
   list from `agy models` (Gemini 3.x, Claude Sonnet/Opus 4.6, GPT-OSS 120B); whether any is free is not
   confirmed.
5. **Working directory**: Codex has `-C/--cd`. **Antigravity has no directory flag** — it uses the process
   cwd, and additionally gates on a `trustedWorkspaces` list in its settings file. `--add-dir` does **not**
   bypass that gate (Antigravity's own answer, consistent with the observed redirect of writes to its scratch
   directory). Per-run worktree paths are freshly created and never in `trustedWorkspaces`, so an
   Antigravity-driven stage would need that file maintained at runtime — the sharpest structural mismatch
   found with this project's design.
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

10. **Cross-review (§10)**: each CLI was then asked to review this document's claims about itself, and every
    disputed claim was re-probed rather than accepted. That round corrected four defects in the first
    revision — two Codex claims (`-a/--ask-for-approval` is top-level only, not an `exec` flag; `codex apply`
    takes a `<TASK_ID>` and is not a way to apply the local run's diff) and two Antigravity claims (it *does*
    read stdin; it *does* stream text via `text_delta`). Codex ran first-try with no setup. Antigravity took
    three attempts, the first two being silent failures that consumed 41k tokens and returned success with an
    empty response — with a prompt that needed no tools at all.

Remaining open: whether any Antigravity model is free (4), and the shape of `codex exec review`'s output,
which Codex described but which was not independently verified (1).

Net read: **Codex fits the existing pipeline machinery with no changes to how prompts are passed** — stdin,
an enforced read-only sandbox, a JSONL stream and `-C` are all already what the console expects, and it
required no per-directory setup. **Antigravity is a closer fit than the first revision concluded** — the
`ARG_MAX` objection was wrong and it does stream text — but two real obstacles survived re-probing: the
`trustedWorkspaces` gate versus per-run ephemeral worktrees, and a silent-success failure mode that an
orchestrator recording stage outcomes automatically would mis-record as a pass. None of this is a
recommendation to adopt either — SPEC.md §13 still holds.
