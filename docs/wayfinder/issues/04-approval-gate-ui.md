Type: prototype
Status: resolved

## Question

What does the approval checkpoint before the Execute stage look like and do?

Decide:
- What's shown to the user at this checkpoint (full plan text, summary, editable fields?).
- Available actions (approve, edit-then-approve, reject/cancel).
- How the auto-approve default is exposed and overridden — global setting vs per-run toggle.

## Answer

Prototyped 3 structurally different variants (Document, Dashboard, Composer) plus a winning Hybrid, in a standalone HTML mock: [04-assets/approval-gate-prototype.html](04-assets/approval-gate-prototype.html) (published for review at https://claude.ai/code/artifact/8388e33b-da05-4d8d-9e73-24f8b0862f77 — this repo has no Next.js app yet at spec stage, so a static HTML `?variant=` mock stood in for a real throwaway route).

**Winning design — Hybrid (hosted at `?variant=d`):**
- **Sidebar** (from the Dashboard variant): run metadata (project, branch, Execute model) and a pipeline stepper showing Plan (done) → Execute (awaiting approval) → Review (pending). Actions live here, sticky at the bottom: an auto-approve toggle, "Approve & run Execute", and "Reject run".
- **Main area**: a single card holding the full plan Markdown (per ticket 02's Objective/Context/Steps/Acceptance criteria/Out of scope template) in an **editable text area** — the user can edit the plan directly before approving (edit-then-approve). Whatever they leave in the box is written to `.orchestrator/plan.md` and used as-is for Execute. An "● edited" indicator appears once the text diverges from what Claude originally wrote.
- Explicitly dropped: the Composer variant's dark terminal/status-bar chrome — the hybrid uses the same card styling as the rest of the dashboard for visual consistency with the wider app.

**Resolved decisions:**
1. What's shown: the full plan, editable inline (not a summary, not read-only, not per-field editing — one Markdown text block).
2. Available actions: Approve & run Execute, Reject, plus implicit "edit" (just type in the box) before either.
3. Auto-approve: a toggle in the sidebar, visible and overridable on every run's approval screen (per-run visibility of what is, per the Notes/original destination decision, a default-on global setting).
