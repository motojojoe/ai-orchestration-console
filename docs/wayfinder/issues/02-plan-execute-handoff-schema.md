Type: grilling
Status: resolved
Blocked by: 01

## Question

What is the schema/format of the plan file the Plan stage (Claude Code) writes, such that:
- It's a format OpenCode can actually consume as its execution instructions (depends on findings from ticket 01).
- It's structured enough for the Review stage to check the resulting diff against it.
- It's readable in the approval-gate UI (ticket 04) before Execute runs.

Decide: file format (markdown task list vs structured JSON/YAML), where it lives in the repo, and what fields/sections it must contain.

## Answer

**Format:** Plain Markdown, not JSON/YAML. OpenCode's `opencode run` only accepts free-text prompt args (per ticket 01) — a structured schema would just get serialized back to text before use, with no benefit. Markdown also renders directly in the approval-gate UI (ticket 04) and reads naturally for both Claude (Review) and OpenCode (Execute).

**Location:** Committed into the target repo, on the run's dedicated branch (per the git-branch decision in Notes / ticket 09) — path `.orchestrator/plan.md`, written by the backend as the first commit on `orchestrator/<run-id>` before Execute starts. Travels with the diff so intent is visible alongside the change, including at merge time; Review stage reads it straight from the repo rather than via a side channel from the console.

**Required sections (fixed template):**

```markdown
# <short task title>

## Objective
<one-line goal>

## Context
<relevant background/constraints — why this is being done>

## Steps
1. ...
2. ...

## Acceptance criteria
- <conditions that define "done" — Review stage checks the diff against this section>

## Out of scope
- <things this run must NOT touch>
```

`Acceptance criteria` is what ticket 03's Review stage checks the diff against; `Out of scope` bounds what OpenCode should touch during Execute.
