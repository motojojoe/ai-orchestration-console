Type: grilling
Status: resolved

## Question

How are credentials/API keys for Claude Code CLI and OpenCode CLI supplied to the spawned processes?

Decide: inherit from the shell environment the console's Node process runs in, a per-project config file, or an in-app settings screen — and how secrets are stored/displayed if the console holds them itself.

## Answer

**No credential store of its own.** The console spawns Claude Code and OpenCode as child processes that inherit the environment/auth state already present on the machine — the same `opencode auth login` / Claude Code login the user already does from a terminal (per ticket 01: OpenCode reads an env var or `~/.local/share/opencode/auth.json`; Claude Code has its own equivalent). The console never collects, stores, or displays an API key itself — that would duplicate a secrets store each CLI already owns and maintains securely.

**Pre-flight check**: before starting a run, the console does a lightweight check that each CLI's credential file/expected env var is present (not a live API call) and shows an actionable error immediately (e.g. "OpenCode isn't authenticated — run `opencode auth login`") rather than letting the user wait out the 15-minute timeout from ticket 06 only to discover a missing login.
