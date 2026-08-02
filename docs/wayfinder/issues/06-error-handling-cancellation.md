Type: grilling
Status: resolved

## Question

What happens when things go wrong mid-pipeline?

Decide:
- Behavior when a stage's CLI process crashes, errors, or times out.
- How the user cancels a running pipeline mid-stage, and what happens to the in-flight child process.
- What state is left behind after a failure/cancellation (partial git branch, partial history record) and whether/how it's cleaned up.

## Answer

1. **Timeout**: each stage (Plan/Execute/Review) has a configurable per-stage timeout, default **15 minutes**. On timeout, the stage is treated as a failure (below) — the free Execute model in particular may run slower than a paid one, so the default is generous but bounded against a genuinely hung process (e.g. waiting on an auth prompt nobody will answer).
2. **Notification**: on timeout or any stage failure, fire an **OS-level desktop notification** via the browser Notification API (permission requested on first app load), so the user finds out even if they've switched away from the tab. An in-app banner/history entry is the fallback/permanent record regardless of notification permission state.
3. **Cancellation**: cancelling sends **SIGTERM to the running child process (Claude Code or OpenCode), waits up to 5 seconds, then SIGKILL** if it hasn't exited — graceful-first so an in-progress file write (mainly during Execute) isn't torn mid-write, with a forced fallback so a stuck process can't block the UI indefinitely.
4. **State after failure/cancellation**: **nothing is auto-deleted.** The run's git branch and its history record are kept, with the record's status set to `failed` or `cancelled`. Automatic cleanup risks silently discarding partial progress the user hasn't looked at yet; deletion is a manual action the user takes later if they want it. This is consistent with the "keep run history" decision already in the Destination.

**Interaction with ticket 05's retry cap**: hitting the 3-cycle Execute↔Review retry cap is not itself a crash/timeout — it should surface the same way (prominent in-app state, no silent auto-cleanup) but does not need the desktop notification path unless a later cycle also times out or errors.
