# OpenCode CLI — Headless/Non-Interactive Execution: Research Findings

Research date: 2026-08-02
Repository inspected: `sst/opencode` on GitHub, default branch `dev` (confirmed via `GET https://api.github.com/repos/sst/opencode` → `"default_branch": "dev"`)
Primary source file for CLI behavior: `packages/opencode/src/cli/cmd/run.ts` (fetched via `raw.githubusercontent.com/sst/opencode/dev/...`, 1011 lines as of this research)

---

## 1. What flag(s) run OpenCode non-interactively against a task/instruction?

**Answer:** There is a dedicated `opencode run [message..]` subcommand. Non-interactive, single-shot execution is the *default* behavior of this subcommand (there is no separate `--print`/`--headless` flag needed) — it sends one prompt, streams events to stdout, and exits when the session goes idle. A companion `--attach` flag lets `run` target an already-running headless `opencode serve` server instead of spinning up an in-process one.

**Detail / citations:**
- Docs: https://opencode.ai/docs/cli/ — "`opencode run [message..]` — Run opencode in non-interactive mode by passing a prompt directly... useful for scripting, automation, or when you want a quick answer without launching the full TUI."
- Source: `packages/opencode/src/cli/cmd/run.ts`, lines 3–15 (header comment):
  > "Handles three modes: 1. Non-interactive (default): sends a single prompt, streams events to stdout, and exits when the session goes idle. 2. Interactive local (`opencode --mini`)... 3. Interactive attach (`opencode --mini --attach`)..."
- Command registration: `run.ts` lines 126–128: `command: "run [message..]"`, `describe: "run opencode with a message"`.
- Interactive mode is opt-in via `--mini`/`--interactive`/`-i` flags (lines 220–241); non-interactive is what happens when neither is passed.
- Separately, `opencode serve` ("Start a headless OpenCode server for API access") and `opencode web` ("headless OpenCode server with a web interface") exist as standalone headless server commands, per https://opencode.ai/docs/cli/, distinct from `run`.

---

## 2. How does it accept its instructions?

**Answer:** A combination — positional CLI arguments (the prompt text), a `--command` flag for slash-commands, `--file`/`-f` for attaching files to the message, and stdin piping (auto-detected when stdin is not a TTY). There is no dedicated "prompt file" flag (no `-f prompt.txt`-as-instruction-source equivalent); `--file` attaches files as message *attachments*, not as the prompt body itself.

**Detail / citations (all `run.ts`):**
- Positional `message` argument, `array: true`, joined into one string: builder at lines 137–142; joined at line 272 (`rawMessage`) and lines 288–290 (quoted rejoining).
- `--command <name>`: "the command to run, use message for args" (lines 143–146); executed via `client.session.command(...)` at lines 840–856.
- `--file`/`-f` (array, max 10 MiB per attached file when in `--attach` mode): lines 180–185, implementation lines 357–414.
- Stdin: `const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()` (line 416); merged with the positional message via `resolveRunInput(message, piped)` (lines 40–50, called at 417–418) — if both are present, piped stdin is appended after the CLI message with a newline.
- Validation: if the resulting message is empty and neither `--command` nor interactive mode is set, OpenCode errors and exits: `"You must provide a message or a command"` (lines 420–423).

---

## 3. What output format(s) are available? Is progress streamed incrementally?

**Answer:** Two formats via `--format {default|json}` (default: `default`). `--format json` emits newline-delimited raw JSON events to stdout as they occur (NDJSON-style event stream), not a single blob at the end — output is genuinely incremental in both formats, driven by an `async for await` loop over a subscribed session event stream that only terminates when the session goes idle. There is no separate `--json`/`--output` flag; format selection is exclusively via `--format`.

**Detail / citations (`run.ts`):**
- Flag definition: lines 174–179 — `.option("format", { type: "string", choices: ["default", "json"], default: "default", describe: "format: default (formatted) or json (raw JSON events)" })`.
- JSON emission helper `emit()`, lines 678–691:
  ```
  function emit(type: string, data: Record<string, unknown>) {
    if (args.format === "json") {
      process.stdout.write(
        JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL,
      )
      return true
    }
    return false
  }
  ```
- Streaming loop: `for await (const event of events.stream)` over `sdk.event.subscribe()` (lines 697, 701, 829) — events are handled and written as they arrive; the loop `break`s only on a `session.status` event with `status.type === "idle"` (lines 788–794).
- JSON-mode event types observed being emitted: `tool_use` (line 720, on tool completion/error), `step_start` (741), `step_finish` (745), `text` (749, on completed text parts), `reasoning` (762, only if `--thinking`), `error` (784, on `session.error`).
- Default (human-readable) mode also streams incrementally: it prints inline/block tool summaries (including diffs for the `edit` tool — see Q6) and text as parts complete, e.g. lines 748–759, using non-TTY-safe plain `process.stdout.write` when stdout is not a terminal (line 752) vs. styled `UI.println` when it is.
- Docs confirm the same two-format description: https://opencode.ai/docs/cli/ lists `--format` as "Format: default (formatted) or json (raw JSON events)" (per doc fetch).
- No dedicated SSE mode is documented for the `run` CLI itself; `opencode serve`/`opencode web` expose an HTTP/event server (`sdk.event.subscribe()` is itself an SSE-style subscription used internally by `run`), but a distinct CLI-level SSE flag is **not documented** as a `run` output-format option.

---

## 4. How is a specific model selected, including a free model, headlessly?

**Answer:** `--model`/`-m` takes a string in `provider_id/model_id` form (e.g. `anthropic/claude-sonnet-4-5`, `opencode/gpt-5.1-codex`). The same `provider_id/model_id` string is the `model` field in `opencode.json`. Priority when resolving which model to use is: CLI flag → config file `model` → last used model → internal default priority. OpenCode Zen (`opencode/<model-id>`) is the primary source that names explicitly **free** models.

**Detail / citations:**
- CLI flag: `run.ts` lines 165–169: `.option("model", { type: "string", alias: ["m"], describe: "model to use in the format of provider/model" })`.
- Parsing: `pick()` function, lines 31–38, splits on `/`: `providerID` = text before first `/`, `modelID` = remainder.
- Config file (docs https://opencode.ai/docs/config/ and /docs/models/):
  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "model": "anthropic/claude-sonnet-4-5",
    "small_model": "anthropic/claude-haiku-4-5"
  }
  ```
  Docs state: "Here the full ID is `provider_id/model_id`."
- Model resolution priority — per https://opencode.ai/docs/models/: (1) `--model`/`-m` CLI flag, (2) model specified in config file, (3) the last used model, (4) "the first model using an internal priority."
- **Free models** — per https://opencode.ai/docs/zen/ (OpenCode Zen page): "OpenCode Zen is a list of tested and verified models provided by the OpenCode team," accessed as `opencode/<model-id>`. The page names seven models explicitly marked free (for a limited period, in exchange for usage feedback): **Big Pickle, DeepSeek V4 Flash Free, MiMo-V2.5 Free, Laguna S 2.1 Free, Ling-3.0-flash Free, North Mini Code Free, Nemotron 3 Ultra Free**. Example ID pattern given on the page: "for GPT 5.5, you would use `opencode/gpt-5.5`" — by the same pattern a free model would be selected headlessly as e.g. `opencode run --model opencode/big-pickle "..."` (this exact invocation string is not itself quoted in the docs; it is constructed from the documented `provider/model` and `opencode/<model-id>` patterns).
- Other free/low-cost options mentioned in https://opencode.ai/docs/providers/: **Ollama** (local, self-hosted, free), **NVIDIA build.nvidia.com** ("Free tier available"), **OpenCode Go** (described as a "low-cost subscription for open models," not free).
- `opencode models [provider]` CLI command lists available models per-provider (per https://opencode.ai/docs/cli/), which can be used to discover current free-model IDs before selecting one via `--model`.

---

## 5. How is the target working directory specified?

**Answer:** A `--dir` flag on `run` (no `-C`/`--cwd`/`--directory` alias exists in source). When not attaching to a remote server, OpenCode resolves the directory and calls `process.chdir()` into it before executing. When attaching to a remote server (`--attach`), `--dir` is instead sent as a path on the remote server rather than used for a local `chdir`. If `--dir` is omitted, OpenCode operates on the process's actual current working directory (`process.env.PWD` or `process.cwd()`).

**Detail / citations (`run.ts`):**
- Flag: lines 204–207: `.option("dir", { type: "string", describe: "directory to run in, path on remote server if attaching" })`.
- Directory-load hook for the command's own instance bootstrap: line 134 — `directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd())`.
- Runtime resolution, lines 333–345:
  ```
  const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
  const directory = (() => {
    if (!args.dir) return args.attach ? undefined : root
    if (args.attach) return args.dir
    try {
      process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
      return process.cwd()
    } catch {
      UI.error("Failed to change directory to " + args.dir)
      process.exit(1)
    }
  })()
  ```
- No environment variable is documented or found in source specifically for overriding the run directory (distinct from `PWD`, which is just read as the OS-supplied fallback, not an OpenCode-specific override variable).
- Related: project config discovery separately "first looks for a config file in the current directory, then traverses up to the nearest Git directory" (https://opencode.ai/docs/config/) — this affects which `opencode.json` is loaded, not the working directory used for prompt execution.

---

## 6. What does OpenCode report about what it changed? Exit codes, file lists, diffs?

**Answer:** Exit code 0 means the run completed without the process explicitly marking an error; exit code 1 is set on session/tool errors, API/session errors, or CLI usage/validation failures. OpenCode does **not** print a final aggregate diff or "list of files changed" manifest at the end of a `run` invocation. Instead, it streams a **per-tool-call diff** as each `edit` operation completes (both in human format and, embedded in the tool-call payload, in `--format json`), because file edits are applied as direct filesystem writes and the diff is computed and attached as tool metadata at the moment of the write. Internally, OpenCode also maintains a separate git-based "Snapshot" service that tracks cumulative session-level diffs for its own checkpoint/revert feature, but this research did not find a public CLI flag or documented REST endpoint that surfaces an aggregated end-of-run diff/manifest — a caller wanting a full before/after diff of a run would need to compute it separately (e.g., via `git diff`/`git status` on the actual project working tree), unless they build their own integration against the internal Snapshot service, whose external HTTP-API surface was not confirmed in this research.

**Detail / citations:**

*Exit codes (`run.ts`):*
- Success path has no explicit `process.exitCode` assignment — Node/Bun default exit code 0 applies.
- `process.exitCode = 1` set on: event-loop/subscription errors caught (line 830–833: `.catch((e) => { console.error(e); process.exitCode = 1 })`); an `error` string produced from a `session.error` event during the loop causing `finish()` to set exit code (lines 818, 836–837: `const error = await completed; if (error) process.exitCode = 1`); a failed `client.session.command()` result (lines 849–851); a failed `client.session.prompt()` result (lines 866–868).
- `process.exit(1)` called directly (via the local `die()` helper, lines 276–279, and inline) for usage/validation failures, e.g.: missing message/command (420–423), `--fork` without `--continue`/`--session` (425–428), file-not-found for `--file` (363–366), failed `chdir` for `--dir` (341–344), session not found (464–467, 673–675), and various `--mini`/`--replay-limit` misuse checks (292–321).

*Direct filesystem writes (no git commit involved):*
- `packages/opencode/src/tool/edit.ts` line 111 and 155: `yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))` — writes the file directly.
- `packages/opencode/src/tool/write.ts` line 64: `yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))`.

*Per-tool-call diff, streamed as it happens:*
- `packages/opencode/src/tool/edit.ts` line 10: `import { createTwoFilesPatch, diffLines } from "diff"`; line 101: `diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))`; the diff string is attached as tool metadata (e.g. lines 106–111, 149–155, 188–207: `metadata: { diff, filediff, ... }`).
- `packages/opencode/src/cli/cmd/run/tool.ts` lines 349–356 (`runEdit`): for the `edit` tool, the CLI's human-format inline block body is set directly to `p.metadata.diff` — i.e., the unified diff text is printed to the terminal as each edit completes.
- `run.ts` lines 715–726: when a `tool` part reaches `completed`/`error` status, if `--format json` the *entire* part object (`emit("tool_use", { part })`) — which includes `metadata.diff` for edit operations — is written as one JSON line; otherwise the human-readable `tool()`/`toolError()` formatting (which pulls in `runEdit`/`runWrite`/`runPatch` from `tool.ts`) is invoked.
- The `write` tool's inline summary shows the tool's own textual output (`p.frame.state.output`), not a diff (`run/tool.ts` lines 332–339); `apply_patch` shows only a file count (`run/tool.ts` lines 403–416), with diff detail available via its `snap` structured-snapshot path (`run/tool.ts` lines 534–566) rather than the plain `run` inline output.

*Internal session-level snapshot/diff service (not confirmed as an exposed `run`-time summary):*
- `packages/opencode/src/snapshot/index.ts` defines a `Snapshot.Service` with methods `track`, `patch(hash)`, `revert(patches)`, `diff(hash)`, and `diffFull(from, to)` (interface at lines 36–44; implementations around lines 349–408, 526–751), which shell out to `git` (`git diff`, `git diff --cached --name-only`, `git diff --name-status`, `git cat-file --batch`, etc., per greps at lines 237, 349–360, 526–530, 546, 685–700) against an internal git storage layer used for the session revert/checkpoint feature (there is also a `packages/opencode/src/session/revert.ts` file, confirmed present in the `session/` directory listing).
- This research did **not** find a documented CLI flag on `run` (e.g. `--diff`, `--summary`) or a confirmed public REST route that exposes this Snapshot service's `diffFull` as an end-of-run change manifest; the `server/routes/instance/httpapi` route tree exists but was not exhaustively enumerated in this research. **Not documented in primary sources as of this research** whether/how this internal snapshot diff is exposed externally beyond the per-edit diffs already covered above.

---

## 7. What auth/config setup is required before headless execution?

**Answer:** Two paths, only one of which is purely non-interactive: (a) **environment variables** — export the provider's expected API-key env var (e.g. via `.env` in the project or the shell environment) and OpenCode auto-detects it at startup with zero interactive steps; or (b) an interactive `opencode auth login` (alias of `opencode providers login`) command, which for some providers is a simple API-key paste but for others (Anthropic Claude Pro/Max, GitHub Copilot) opens a browser for OAuth/device-code flow and cannot be completed non-interactively. Resolved credentials are cached in a JSON file at `~/.local/share/opencode/auth.json`.

**Detail / citations:**
- `opencode auth login` is documented at https://opencode.ai/docs/cli/: "OpenCode is powered by the provider list at Models.dev, so you can use `opencode auth login` to configure API keys for any provider you'd like to use." Credentials are "stored in `~/.local/share/opencode/auth.json`."
- Source confirms `auth` is a yargs alias of the `providers` command group: `packages/opencode/src/cli/cmd/providers.ts` line 241: `aliases: ["auth"]` on `command: "providers"` (line 240); the actual login subcommand is `login [url]` (line 300), `describe: "log in to a provider"`.
- Non-interactive / env-var path — docs https://opencode.ai/docs/providers/: "When OpenCode starts up it loads the providers from the credentials file. And if there are any keys defined in your environments or a `.env` file in your project."
- Source confirms env-var auto-detection: `providers.ts` `ProvidersListCommand` handler, lines 273–283:
  ```
  for (const [providerID, provider] of Object.entries(database)) {
    for (const envVar of provider.env) {
      if (process.env[envVar]) {
        activeEnvVars.push({ provider: provider.name || providerID, envVar })
      }
    }
  }
  ```
  — each provider's known env var name(s) come from the Models.dev database (`ModelsDev.Service`), and OpenCode picks them up automatically with no `auth login` step required.
  - Credentials file path in source: `providers.ts` line ~258: `const authPath = path.join(Global.Path.data, "auth.json")`.
- OAuth-requiring providers (interactive step unavoidable) — https://opencode.ai/docs/providers/: Anthropic "Claude Pro/Max" option "will open your browser and ask you to authenticate"; GitHub Copilot uses a "device code flow at `github.com/login/device`."
- Config-level credential/config overrides (non-interactive, doc https://opencode.ai/docs/config/): `OPENCODE_CONFIG` env var points to a custom config file path; `OPENCODE_CONFIG_CONTENT` env var supplies inline config content; config files also support `{env:VAR_NAME}` substitution syntax for pulling secrets from the environment into `opencode.json`.
- Config-file provider auth example (custom OpenAI-compatible provider, https://opencode.ai/docs/providers/):
  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "provider": {
      "custom-id": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "Display Name",
        "options": { "baseURL": "https://api.example.com/v1" },
        "models": { "model-id": { "name": "Model Display Name" } }
      }
    }
  }
  ```

---

## Sources consulted

- https://opencode.ai/docs/cli/
- https://opencode.ai/docs/
- https://opencode.ai/docs/models/
- https://opencode.ai/docs/zen/
- https://opencode.ai/docs/providers/
- https://opencode.ai/docs/config/
- `https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/cli/cmd/run.ts`
- `https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/cli/cmd/run/tool.ts`
- `https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/cli/cmd/providers.ts`
- `https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/cli/cmd/account.ts`
- `https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/tool/edit.ts`
- `https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/tool/write.ts`
- `https://raw.githubusercontent.com/sst/opencode/dev/packages/opencode/src/snapshot/index.ts`
- GitHub Contents API listings of `packages/opencode/src/cli/cmd`, `packages/opencode/src/session`, `packages/opencode/src/snapshot`, `packages/opencode/src/server`, `packages/opencode/src/server/routes`, `packages/opencode/src/provider` (used to confirm file existence/structure, not for prose claims)
