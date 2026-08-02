Type: grilling
Status: resolved

## Question

How is the Review stage's verdict displayed, and what can the user do with it?

Decide:
- Where/how the review output is shown (inline with the diff, separate panel, pass/fail badge).
- Whether a "needs changes" verdict blocks the run from being marked done, or is purely informational.
- Whether the user can trigger another Execute pass from Review feedback, and if so, how that loops back into the pipeline.

## Answer

1. **Display**: the Review screen shows the `git diff` (unified diff, red/green) together with the verdict (from ticket 03's `VERDICT: APPROVE`/`NEEDS_CHANGES` line) and Claude's reasoning, in one view — not split across separate panels the user has to hunt for, and not verdict-only. Reuses the ticket 04 hybrid layout's stepper (now showing Review as done/flagged) and card styling.
2. **`NEEDS_CHANGES` is informational, not blocking.** It surfaces as a prominent warning badge (on the stepper and the run header) but never prevents the user from closing the run as-is — this is a single-user tool, not a team gate, and a hard block would fight the auto-approve philosophy already settled for the pipeline.
3. **Retry loop**: a "Retry Execute" action re-invokes the Execute stage **on the same run branch**, appending Review's `NEEDS_CHANGES` reasoning to OpenCode's instructions (not a fresh Plan/branch). Then Review runs again. **Capped at 3 Execute↔Review cycles per run** — beyond that, the user must intervene manually (edit the plan themselves, close the run despite `NEEDS_CHANGES`, or cancel it). The retry cap and its interaction with cancellation/failure states is a detail ticket 06 (error handling & cancellation) should account for.
