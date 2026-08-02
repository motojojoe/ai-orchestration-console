Type: grilling
Status: resolved

## Question

How should the console invoke Claude Code CLI headlessly for the Plan stage and the Review stage?

Decide:
- CLI flags to use (e.g. `-p`, `--output-format stream-json`, permission mode) for each stage.
- How the Plan-role prompt/system-prompt differs from the Review-role prompt.
- Whether each stage runs as a fresh session or resumes/shares context with a prior stage.
- How stage output is parsed into structured data the console can store and display (vs just raw text).

## Answer

**Plan stage:**
- Invoke with `--print --permission-mode plan --output-format stream-json --verbose` (plan mode guarantees zero filesystem side effects during planning — enforced by Claude Code itself, not by our tool allowlist).
- Fresh session every run (no `--resume`).
- The console's Node backend, not Claude, writes the plan file: it captures the final `result` message from the stream, and writes that text to the plan file path in the target repo (schema/location decided in ticket 02).

**Execute stage:** unchanged — handled by OpenCode per ticket 01/02, not Claude Code.

**Review stage:**
- Invoke with `--print --output-format stream-json --verbose`, default (non-plan) permission mode but restricted via `--allowedTools` to read-only tools (`Read`, `Grep`, `Glob`) — no `Edit`/`Write`/`Bash`. The backend passes the plan file's contents and the `git diff` output (computed by the backend itself, not by Claude) directly in the prompt, so Review doesn't need shell access to inspect the change — it only needs read access to the repo for extra context if it wants to look around.
- Fresh session every run — never resumes Plan's session. Review only sees what's written down (plan file + diff), never Plan's internal reasoning trace. Matches normal code-review practice: an independent read guards against rubber-stamping.
- The prompt requires the response to start with a machine-parseable verdict line — `VERDICT: APPROVE` or `VERDICT: NEEDS_CHANGES` — followed by free-text reasoning. The backend parses this line to drive pass/fail UI state (detail in ticket 05); the rest is stored/displayed as-is.

**Streaming/parsing (both stages):** `stream-json` emits NDJSON events; the backend forwards each event over the already-decided SSE channel as it arrives, and separately buffers the stream to extract the final `result` event as the stored structured output (plan text, or verdict + reasoning) for history (SQLite, per Notes).
