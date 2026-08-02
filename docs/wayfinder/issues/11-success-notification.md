Type: grilling
Status: resolved

## Question

Should a successful run completion also fire a desktop notification — the mechanism itself (browser Notification API) is already settled for failures/timeouts, per ticket 06.

Decide:
- Whether success notifications are on by default, or opt-in.
- Whether the Review verdict (`APPROVE` vs `NEEDS_CHANGES`) changes whether/how the notification fires (e.g. different tone or urgency for a run that needs attention vs one that's clean).
- What the notification says (content/summary shown).

## Answer

**Default**: on, reusing the same Notification permission already requested in ticket 06 (no separate prompt). Rationale unchanged from the failure/timeout case — pipelines run long enough that the user won't be watching the screen, and they want to know the moment a run finishes regardless of outcome.

**Content varies by verdict**, both including the run's task title:
- `APPROVE` → e.g. "✅ Add rate limiting to the public API — done, ready to merge."
- `NEEDS_CHANGES` → e.g. "⚠️ Add rate limiting to the public API — Review flagged issues, needs a look."

This lets the user triage from the notification itself (urgent vs. safe to check later) without opening the app first.
