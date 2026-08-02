Type: grilling
Status: resolved

## Question

How does the user select and validate the target project for a pipeline run?

Decide:
- Input mechanism (manual path entry, native file/folder browser, a saved list of recent projects).
- Validation before a run can start (must be a git repo, must have a clean working tree, etc.) and how validation failures are surfaced.

## Answer

**Technical constraint noted first**: the frontend runs in a browser, which cannot open a native OS folder picker that returns a real absolute filesystem path (browser sandboxing) — a "browse" UI would require a custom server-driven directory walker via API. Deferred as unnecessary for v1 (see below).

**Input mechanism**: manual absolute-path text entry, plus a **recent-projects list** (persisted, likely alongside run history in the SQLite store from Notes) that the user can pick from after the first run. No custom directory-browser API — the user already knows their own project paths; this is a personal tool, not a general-audience product. Revisit if this proves annoying in practice.

**Validation before a run can start** (all checked at project-selection time, before Plan even runs):
1. The path exists and is a directory.
2. It's a git repository (required for the per-run branch model already settled in Notes/ticket 09-adjacent decisions).
3. The working tree is **clean** — no uncommitted/staged changes. Required because creating the run's branch from a dirty tree makes it ambiguous whether in-flight edits belong to the new run or the user's own concurrent work.

Failures surface as an actionable inline error at the project-selection step (e.g. "Uncommitted changes in this repo — commit or stash them before starting a run"), not as a pipeline failure discovered later.
