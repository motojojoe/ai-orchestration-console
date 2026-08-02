Type: grilling
Status: resolved

## Question

What is the full lifecycle of the per-run git branch?

Decide:
- Branch naming convention.
- Whether Execute runs via a plain branch checkout or an isolated git worktree (to avoid disrupting the user's active working tree in the same directory).
- What happens to the branch after Review completes (auto-merge, left for manual merge) and after a run is rejected/cancelled (auto-delete vs kept).

## Answer

**Naming**: `orchestrator/<run-id>` (already settled in the map's Notes during frontier-mapping).

**Isolation**: a dedicated **git worktree** per run (e.g. `<project>/.orchestrator-worktrees/run-<id>/`, branch `orchestrator/run-<id>` checked out into it), not a plain in-place checkout. The user's main working directory is never touched while a run is in flight, even if they have the project open in an editor/IDE concurrently.

**After Review approves**: **no auto-merge.** The branch is left ready for the user to merge through their own normal git workflow; the run is marked complete/approved in history. Auto-approve (deciding whether Execute waits for a human) and merging into the main branch (a higher-consequence action, e.g. triggers CI/deploy) are different decisions — the console prepares a reviewed branch, it doesn't take the merge action itself.

**Worktree cleanup**: once a run reaches any terminal state (approved, closed with `NEEDS_CHANGES`, failed, or cancelled), the **worktree directory is removed automatically** — this doesn't conflict with ticket 06's "nothing auto-deleted" rule, because that rule protects data (the branch's commits, the history record); a worktree is just a disposable checked-out copy, fully recoverable from the branch at any time via `git worktree add` or a normal checkout. The branch itself is never deleted automatically.
