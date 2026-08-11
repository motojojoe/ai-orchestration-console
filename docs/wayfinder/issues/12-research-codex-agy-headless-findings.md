# Codex CLI & Antigravity CLI — Headless/Non-Interactive Execution: Research Findings

Research date: 2026-08-11

Unlike [ticket 01](01-research-opencode-headless-findings.md), which was researched by reading OpenCode's
published source, this research was done by **exercising both binaries directly** on the development machine.
Every claim below is either quoted from the binary's own `--help` output or observed in a recorded probe run.
Where a claim could not be established that way, it says so explicitly.

Versions and environment under test:

| | Version | Path | Reported by |
|---|---|---|---|
| Codex CLI | `codex-cli 0.147.0` | `~/.local/bin/codex` | `codex --version` |
| Antigravity CLI | `1.1.11` | `~/.local/bin/agy` | `agy --version` |

- Host: macOS (Darwin 27.0.0), `getconf ARG_MAX` → **1048576** bytes.
- Probe repository: a throwaway `git init` directory containing a single committed `calc.py`.

Both CLIs are single-shot agent harnesses in the same family as Claude Code and OpenCode, so this document
follows the same question set as ticket 01, plus two questions this project cares about that ticket 01 did not
need to ask (Q6 read-only enforcement, Q8 usage/cost reporting).

---

## 1. What flag(s) run each CLI non-interactively?

**Answer:** Both have a dedicated non-interactive path, but they are shaped differently. Codex uses a
**subcommand** (`codex exec`); Antigravity uses a **flag that carries the prompt as its value**
(`agy --print "<prompt>"`). The Antigravity form is a genuine footgun and is covered in Q2.

**Detail / citations:**

*Codex* — `codex --help` lists under `Commands:`
> `exec            Run Codex non-interactively [aliases: e]`

`codex exec --help` confirms the usage line `codex exec [OPTIONS] [PROMPT]`. Two further non-interactive
subcommands exist and are relevant to this project's stage design:
- `codex review` (top-level) — *"Run a code review non-interactively"*.
- `codex exec review` — *"Run a code review against the current repository"*.

Neither `review` variant was probed in this research; **their output shape is not confirmed here.**

*Antigravity* — `agy --help` lists:
> `--print                         Run a single prompt non-interactively and print the response`
> `-p                              Short alias for --print`
> `--prompt                        Alias for --print`

There is no `exec`-style subcommand. `agy`'s subcommands (`agent`, `models`, `plugin`, `update`,
`changelog`, `install`, `help`) are all utility commands, not execution modes.

---

## 2. How does each accept its instructions — prompt string, file path, or stdin?

**Answer:** **Codex accepts stdin; Antigravity does not.** Codex takes the prompt as a positional argument, as
`-` (explicit stdin), or as piped stdin, and appends piped stdin to an argv prompt when both are present.
Antigravity accepts the prompt **only as the value of `--print`/`-p`**, ignores stdin entirely, and errors out
if that value is empty. Neither CLI has a "read the prompt from this file" flag.

This is the single most consequential difference for this project, because `src/lib/cli/process.ts`
deliberately feeds prompts over stdin rather than argv to avoid `ARG_MAX` limits with large plans and diffs.

**Detail / citations:**

*Codex* — `codex exec --help`, `Arguments:` section, quoted verbatim:
> `[PROMPT]`
> `Initial instructions for the agent. If not provided as an argument (or if `-` is used), instructions are read from stdin. If stdin is piped and a prompt is also provided, stdin is appended as a `<stdin>` block`

Probe run confirming stdin works:
```
printf 'Reply with exactly: STDIN_CODEX_OK' \
  | codex exec --json -s read-only --skip-git-repo-check -
```
→ emitted `item.completed` with `item.text == "STDIN_CODEX_OK"`. Codex also wrote
`Reading additional input from stdin...` to stderr, confirming it consumed the pipe.

*Antigravity* — three probe runs establish the negative result:

| Probe | Command | Result |
|---|---|---|
| Prompt in argv | `agy --output-format json -p "Reply with exactly: AGY_ARGV_OK"` | `status: "SUCCESS"`, `response: "AGY_ARGV_OK\n"` |
| Piped stdin, `-` as value | `printf '…' \| agy --output-format json -p -` | `status: "SUCCESS"`, but the response was a generic *"Hello! I am ready to help…"* — the literal string `-` was used as the prompt and the piped text was discarded |
| Piped stdin, empty value | `printf '…' \| agy --output-format json -p ""` | `status: "ERROR"`, `error: "Error: empty prompt. Usage: agy --print \"your prompt here\""` — stdin was not consulted |

**Flag-order footgun:** because `--print` takes the prompt as its *value* rather than acting as a boolean
switch, writing the flags in the order `agy -p --output-format json "…"` makes `-p` swallow
`--output-format` as the prompt text. An observed run of that form produced a model reply explaining what
the string `--output-format` means. The prompt value must be bound directly to the flag, and other flags
must come before it: `agy --output-format json -p "<prompt>"`.

**Consequence:** an Antigravity-driven stage would have to pass the full prompt through argv, bounded by this
machine's `ARG_MAX` of 1,048,576 bytes. A plan file plus a full `git diff` can plausibly approach that ceiling
on a large run. Writing the prompt to a temp file and passing only its path in the prompt text is an obvious
workaround, but it relies on the agent choosing to read that file, which was **not probed and is not
confirmed** here.

---

## 3. What output formats are available, and is progress streamed incrementally?

**Answer:** Both emit newline-delimited JSON incrementally. **Their event envelopes are different from each
other and from Claude Code's `stream-json`** — Codex discriminates on a `type` key, Antigravity on an `event`
key. Any consumer must branch per CLI; there is no shared shape to parse generically.

**Detail / citations:**

*Codex* — `codex exec --help`:
> `--json    Print events to stdout as JSONL`
> `-o, --output-last-message <FILE>    Specifies file where the last message from the agent should be written`
> `--output-schema <FILE>    Path to a JSON Schema file describing the model's final response shape`

Observed event sequence from the probe run (`codex exec --json -s read-only`), in order, with the
discriminator being the top-level `type` key:

| Event | Payload observed |
|---|---|
| `thread.started` | `{"thread_id": "019feec2-…"}` |
| `turn.started` | — |
| `item.completed` | `{"item": {"id": "item_0", "type": "agent_message", "text": "PROBE_OK"}}` |
| `turn.completed` | `{"usage": {…}}` — see Q8 |

The agent's final text arrives as an `item.completed` event whose `item.type` is `agent_message`. A single
turn produced one such item; a run involving tool calls would be expected to produce more items of other
types, but **the full item-type vocabulary was not enumerated in this research.**

*Antigravity* — `agy --help`:
> `--output-format    Output format for print mode (text, json, stream-json) (default text)`
> `--json-schema      Optional JSON schema string or path to a schema file to enforce structured output (for stream-json, only applicable to the final result)`

`--output-format json` emits one final JSON object. `--output-format stream-json` emits NDJSON keyed on
`event`, observed as:

```json
{"event":"init","conversation_id":"e1a359f5-…","init":{"cwd":"…","tools":["ask_permission","ask_question","browser_click_element", …]}}
{"event":"step_update","step_update":{"conversation_id":"…","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"…","step_index":1,"state":"DONE","step_type":"unknown","duration_seconds":0.000417}}
{"event":"result","result":{"conversation_id":"…","status":"SUCCESS","response":"PROBE_OK\n","duration_seconds":2.94024,"num_turns":1,"usage":{…}}}
```

The `init` event carries the resolved `cwd` and the full tool list the session was given. The terminal
`result` event carries the agent's complete response text — Antigravity does **not** stream assistant text
token-by-token or part-by-part in this mode; `step_update` events report step state transitions only. A UI
forwarding these events would show step progress during the run but would receive the answer itself only at
the end.

---

## 4. How is a model selected, and are free/cheap models reachable?

**Answer:** Codex uses `-m/--model`, plus `--oss` with `--local-provider {lmstudio|ollama}` for locally hosted
models. Antigravity uses `--model` plus a separate `--effort {low|medium|high}` dial, and ships its own fixed
model list rather than a provider/model addressing scheme.

**Detail / citations:**

*Codex* — `codex exec --help`:
> `-m, --model <MODEL>    Model the agent should use`
> `--oss    Use open-source provider`
> `--local-provider <OSS_PROVIDER>    Specify which local provider to use (lmstudio or ollama). If not specified with --oss, will use config default or show selection`

A default model can also be set in `~/.codex/config.toml` (`model = "…"`), or overridden per-invocation with
`-c model="…"`. **No free-tier hosted model is advertised by the CLI's own help output**; the free route Codex
documents is local inference via `--oss`.

*Antigravity* — `agy --help`:
> `--model    Model for the current CLI session`
> `--effort   Reasoning effort for the current CLI session (low|medium|high)`

`agy models` returned this list (IDs are tab-separated from display names in the real output):

```
gemini-3.6-flash-high / -medium / -low      Gemini 3.6 Flash
gemini-3.5-flash-high / -medium / -low      Gemini 3.5 Flash
gemini-3.1-pro-high / -low                  Gemini 3.1 Pro
claude-sonnet-4-6                           Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking                    Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium                         GPT-OSS 120B (Medium)
```

Note the reasoning tier is baked into several model IDs (`-high`/`-medium`/`-low`) as well as being available
via `--effort`; **how the two interact when both are supplied was not probed.** Antigravity meters usage in
"G1 credits" (there is a `/credits` slash command in the interactive TUI), but **whether any of these models
is free of charge, and how a quota exhaustion surfaces in print mode, is not confirmed by this research.**

---

## 5. How is the target working directory specified?

**Answer:** Codex has an explicit `-C/--cd` flag. **Antigravity has no working-directory flag at all** — it
operates on the process's current working directory, and additionally applies a workspace-trust check against
its own settings file.

**Detail / citations:**

*Codex* — `codex exec --help`:
> `-C, --cd <DIR>    Tell the agent to use the specified directory as its working root`
> `--add-dir <DIR>    Additional directories that should be writable alongside the primary workspace`
> `--skip-git-repo-check    Allow running Codex outside a Git repository`

`--skip-git-repo-check` matters for probe/test scenarios; this project always runs inside a git worktree, so
it would not be needed in production use.

*Antigravity* — the full `agy --help` flag list contains no `--dir`, `--cd`, `-C`, or `--directory` option.
The only directory-related flag is:
> `--add-dir    Add a directory to the workspace (repeatable) (default [])`

The probe confirmed the session's directory comes from the process cwd: the `init` event reported
`"cwd":"…/cli-probe"`, matching the shell's cwd at spawn time. A caller therefore controls Antigravity's
working directory by setting the child process's cwd, not by a flag.

**Workspace trust:** `~/.gemini/antigravity-cli/settings.json` carries a `trustedWorkspaces` array of absolute
paths. When `agy --mode plan` was run inside the untrusted probe repository and asked to create a file, the
plan it produced targeted `~/.gemini/antigravity-cli/scratch/` rather than the probe repo (see Q6). Passing
`--add-dir <probe repo>` did not resolve this — that run failed on the permission wall described in Q7
instead. **Whether `--add-dir` alone is sufficient to make an arbitrary new directory writable without a
prior `trustedWorkspaces` entry is therefore NOT confirmed by this research**, and it is the single most
important open question for using Antigravity against per-run ephemeral worktrees.

---

## 6. Can each CLI be run genuinely read-only, and is it enforced?

This question has no counterpart in ticket 01 because OpenCode is only ever used for the Execute stage. It
matters here because the Plan and Review stages require a CLI that provably cannot modify the working tree —
today that guarantee comes from Claude Code's `--permission-mode plan` and its `--allowedTools` restriction.

**Answer:** **Yes for both, by different mechanisms, and both were verified to actually block a write.** Codex
enforces it with an OS-level sandbox; Antigravity enforces it with an agent execution mode.

**Detail / citations:**

*Codex* — `codex exec --help`:
> `-s, --sandbox <SANDBOX_MODE>    Select the sandbox policy to use when executing model-generated shell commands`
> `[possible values: read-only, workspace-write, danger-full-access]`
> `-a, --ask-for-approval <APPROVAL_POLICY>` with values `untrusted`, `on-request`, `never`

Verification probe — Codex was explicitly instructed to create a file while under `-s read-only`:
```
codex exec --json -s read-only --skip-git-repo-check \
  "Create a file named WROTE_CODEX.txt containing the word yes. Actually do it."
```
The agent's own messages, captured from `item.completed` events:
> "I'll create `WROTE_CODEX.txt` in the current workspace and verify its contents."
> "I couldn't create `WROTE_CODEX.txt`: the workspace is mounted read-only, and write approval is disabled. No file was created."

A filesystem check afterwards confirmed no such file existed. The block is enforced by the sandbox, not by the
model's cooperation — the agent tried and was refused.

*Antigravity* — `agy --help`:
> `--mode       Set the agent execution mode for this session (accept-edits, plan)`
> `--sandbox    Run in a sandbox with terminal restrictions enabled`

Verification probe under `--mode plan` with the same instruction produced `status: "SUCCESS"` and this
response:
> "I have created an implementation plan for creating `WROTE_AGY.txt`. Please review
> [implementation_plan.md](file:///Users/…/.gemini/antigravity-cli/brain/f63d05f7-…/implementation_plan.md)
> and let me know if you approve so I can execute it."

No file was created in the probe repository. Note, however, that plan mode is **not** globally read-only: it
wrote a real `implementation_plan.md` (plus an `implementation_plan.md.metadata.json`) into its own per-
conversation brain directory at `~/.gemini/antigravity-cli/brain/<conversation_id>/`. The workspace is
protected; the CLI's own state directory is not.

That plan artifact is a structured Markdown document with `## Proposed Changes` and `## Verification Plan`
sections, written to a path derivable from the `conversation_id` present in every stream event — so a caller
can locate and read it deterministically. **`--sandbox` was not probed separately**, and how it composes with
`--mode` is not confirmed.

---

## 7. What does each report about what it changed, and what are the exit codes?

**Answer:** Neither CLI emits an aggregate end-of-run diff or changed-file manifest — the same conclusion
ticket 01 reached for OpenCode, so this project's existing "compute the diff ourselves with `git diff`"
decision holds for these CLIs too. Codex additionally ships an `apply` subcommand that goes the other
direction. Antigravity has an exit-code trap that must not be missed.

**Detail / citations:**

*Codex* — no `--diff` or summary flag appears in `codex exec --help`. Related but distinct, `codex --help`
lists:
> `apply    Apply the latest diff produced by Codex agent as a `git apply` to your local working tree [aliases: a]`

That applies Codex's own produced diff to the tree; it is not a reporting surface. All probe runs exited `0`;
**non-zero exit behaviour was not probed and is not documented here.**

*Antigravity* — **a failed run can exit `0` with `status: "SUCCESS"` and an empty response.** This was
observed directly. When Antigravity was asked a question requiring a tool it had no allow-rule for, the run
returned:

```json
{"conversation_id":"c29cfe66-…","status":"SUCCESS","response":"","duration_seconds":17.98823,
 "num_turns":1,"usage":{"input_tokens":23417,"output_tokens":633,"thinking_tokens":496,
 "cache_read_tokens":0,"total_tokens":24050}}
```

with this line written separately (not inside the JSON):
> `jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.`

So exit code `0` and `status: "SUCCESS"` together are **not** sufficient to conclude a run succeeded — a
caller must additionally check that `response` is non-empty. This is the same class of trap already recorded
in the repository's `CLAUDE.md` for OpenCode (which exits `0` on `SIGTERM`), and the same root cause as
OpenCode's need for `--dangerously-skip-permissions`: no TTY exists in which to answer a permission prompt,
so the harness auto-denies.

The two documented escapes are an explicit allow-list under `permissions.allow` in
`~/.gemini/antigravity-cli/settings.json`, or `--dangerously-skip-permissions`
(*"Auto-approve all tool permission requests without prompting"*, per `agy --help`).

Antigravity also has `--print-timeout` (*"Timeout for print mode wait"*, default `5m0s`), which is its own
stage-timeout mechanism independent of any imposed by a caller.

---

## 8. What usage or cost figures does each report?

This question has no counterpart in ticket 01. It matters because SPEC.md §11 records token/cost **only if the
CLI itself reports it, never estimated**.

**Answer:** Both report token counts. **Neither reports a monetary cost.** Antigravity additionally reports
wall-clock duration and turn count.

**Detail / citations:**

*Codex* — the terminal `turn.completed` event, verbatim from the probe:
```json
{"type":"turn.completed","usage":{"input_tokens":14021,"cached_input_tokens":11008,
 "cache_write_input_tokens":0,"output_tokens":7,"reasoning_output_tokens":0}}
```
Five token counters, no cost field. Note `reasoning_output_tokens` is broken out separately from
`output_tokens`.

*Antigravity* — the `usage` object inside the terminal `result` event, verbatim:
```json
{"input_tokens":22596,"output_tokens":376,"thinking_tokens":368,
 "cache_read_tokens":0,"total_tokens":22972}
```
plus sibling fields `duration_seconds` and `num_turns` on `result` itself. No cost field; no
`cache_write` counterpart to Codex's `cache_write_input_tokens`.

Neither CLI's counter set lines up field-for-field with the other, or with Claude Code's `stream-json` result
event (which does carry cost). Any storage schema covering all three needs either a superset of columns or a
per-CLI JSON blob.

---

## 9. What auth and config setup is required before headless execution?

**Answer:** Both inherit machine-level login state, matching the "no credential store in the console" decision
in ticket 07 — neither needs an API key passed at invocation time. Both also read a config file that can
change behaviour without any flag, which is worth being aware of when reproducing a run.

**Detail / citations:**

*Codex*
- Credentials live at `~/.codex/auth.json`. On the machine under test this file recorded an `auth_mode`, a
  null `OPENAI_API_KEY`, and an OAuth token triple (`id_token`, `access_token`, `refresh_token`) with an
  `account_id` and `last_refresh` timestamp — i.e. a ChatGPT OAuth login rather than a raw API key.
- `codex login` / `codex logout` manage that state; `codex doctor` *"Diagnose local Codex installation,
  config, auth, and runtime health"* is a ready-made pre-flight check.
- Config is `~/.codex/config.toml`. Relevant escape hatches from `codex exec --help`:
  `--ignore-user-config` (*"Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`"*),
  `-p/--profile` (layers `$CODEX_HOME/<name>.config.toml` on top), `-c key=value` for one-off overrides,
  and `--strict-config` to error on unrecognised fields.
- `--ephemeral` (*"Run without persisting session files to disk"*) suppresses session persistence.
- Config also carries a per-project `trust_level` (`[projects."<abs path>"] trust_level = "trusted"`),
  so an unfamiliar directory may behave differently from a trusted one. **The exact effect of an untrusted
  project on `codex exec` was not probed.**

*Antigravity*
- Settings live at `~/.gemini/antigravity-cli/settings.json`. The file under test contained a
  `permissions.allow` array of tool allow-rules (e.g. `"command(which)"`) and a `trustedWorkspaces` array of
  absolute paths — both directly load-bearing per Q5 and Q7.
- Per-conversation state, logs and plan artifacts live under `~/.gemini/antigravity-cli/`
  (`brain/`, `conversations/`, `log/`, `history.jsonl`).
- The install location is `~/.local/bin/agy`, per the official installer
  (`curl -fsSL https://antigravity.google/cli/install.sh | bash`).
- **How Antigravity stores its auth token was deliberately not investigated** — establishing it would have
  meant enumerating the macOS Keychain, which is out of proportion to this research. Google's documentation
  refers to "secure keyring auth permissions", but the concrete storage location is **not confirmed here.**
  Practically, the CLI was already authenticated on the test machine and every probe run succeeded without
  any credential being supplied at invocation time, which is what ticket 07's inherited-auth model requires.
- No `doctor`-equivalent pre-flight command appears in `agy --help`.

---

## Sources consulted

Primary — the installed binaries themselves:
- `codex --version`, `codex --help`, `codex exec --help` (codex-cli 0.147.0)
- `agy --version`, `agy --help`, `agy models` (1.1.11)
- Recorded probe runs of `codex exec --json` (argv prompt, stdin prompt, read-only write attempt)
- Recorded probe runs of `agy` (`--output-format json` and `stream-json`; argv/stdin/empty prompt variants;
  `--mode plan` write attempt; `--add-dir` permission-wall run)
- Config/state files on the test machine: `~/.codex/config.toml`, `~/.codex/auth.json` (structure only),
  `~/.gemini/antigravity-cli/settings.json`, `~/.gemini/antigravity-cli/brain/<conversation_id>/`

Secondary — vendor documentation, used only for install/overview context, not for behavioural claims:
- https://antigravity.google/docs/cli/getting-started
- https://antigravity.google/docs/cli/reference
- https://developers.openai.com/codex/config-basic
- https://learn.chatgpt.com/docs/extend/mcp?surface=cli
