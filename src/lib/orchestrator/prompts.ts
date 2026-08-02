/** Spec §3.1 + §4: Plan must research read-only and reply with only the plan template. */
export function buildPlanPrompt(task: string): string {
  return `You are the Plan stage of an automated coding pipeline. Research this codebase (you cannot edit any files in this mode) and produce a plan for the following task.

Task: ${task}

Reply with ONLY the plan document below, filled in — no preamble, no commentary before or after it:

# <short task title>

## Objective
<one-line goal>

## Context
<relevant background/constraints found in the codebase>

## Steps
1. ...
2. ...

## Acceptance criteria
- <conditions that define "done">

## Out of scope
- <things this run must NOT touch>`;
}

/** Spec §3.2: the plan file's contents are passed as Execute's instructions, as-is. */
export function buildExecutePrompt(planText: string, retryFeedback?: string): string {
  if (!retryFeedback) {
    return `Implement the following plan exactly as written. Do not go beyond its "Out of scope" section.\n\n${planText}`;
  }
  return `Implement the following plan exactly as written. Do not go beyond its "Out of scope" section.

${planText}

A reviewer already looked at your previous attempt and found issues. Address this feedback:

${retryFeedback}`;
}

/** Spec §3.3: Review is fresh — it only ever sees the plan and the diff, never Plan's reasoning. */
export function buildReviewPrompt(planText: string, diffText: string): string {
  return `You are the Review stage of an automated coding pipeline. You were not part of the planning discussion — judge only what is written below.

Here is the plan that was approved:

${planText}

Here is the git diff of the changes that were made:

${diffText || "(no changes were made)"}

Check the diff against the plan's "Acceptance criteria" section. Reply with your verdict as the very first line, exactly one of:

VERDICT: APPROVE
VERDICT: NEEDS_CHANGES

Then give your reasoning on the following lines.`;
}
