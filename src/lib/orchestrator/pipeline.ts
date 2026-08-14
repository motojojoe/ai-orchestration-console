import { randomUUID } from "node:crypto";
import { parseVerdict, runClaude } from "../cli/claude";
import { runOpenCode } from "../cli/opencode";
import {
  commitExecuteChanges,
  computeDiff,
  createRunWorktree,
  removeRunWorktree,
  writePlanFileAndCommit,
} from "../git";
import { ACTIVE_STATUSES, createRun, getRun, type Run, type RunStatus, updateRun } from "../db";
import {
  RunCancelledError,
  StageTimeoutError,
  clearController,
  gracefulStop,
  hasLiveStage,
  isCancelled,
  isPidAlive,
  markCancelled,
  runStage,
  throwIfCancelled,
} from "./control";
import { emitRunEvent } from "./events";
import { buildExecutePrompt, buildPlanPrompt, buildReviewPrompt } from "./prompts";

const RETRY_CAP = 3;
const OPENCODE_MODEL = process.env.ORCHESTRATOR_OPENCODE_MODEL ?? "opencode/deepseek-v4-flash-free";
const TERMINAL_STATUSES: RunStatus[] = ["approved", "closed_needs_changes", "failed", "cancelled"];

function setStatus(runId: string, status: RunStatus, patch: Partial<Run> = {}): void {
  updateRun(runId, { status, ...patch });
  emitRunEvent(runId, { type: "status_change", status });
}

/** Spec §5: the worktree is removed on any terminal state; the branch itself is never deleted. */
async function finalizeTerminal(run: Run): Promise<void> {
  if (run.worktree_path) {
    try {
      await removeRunWorktree(run.project_path, run.worktree_path);
    } catch (err) {
      console.error(`Failed to remove worktree for run ${run.id}:`, err);
    }
    updateRun(run.id, { worktree_path: null });
  }
  updateRun(run.id, { owner_pid: null });
  clearController(run.id);
}

async function failRun(runId: string, stage: "plan" | "execute" | "review", err: unknown): Promise<void> {
  const run = getRun(runId);
  if (!run) return;
  const message = err instanceof Error ? err.message : String(err);

  if (isCancelled(runId)) {
    // A cancelled run carries no failed stage and no stage error. The message here is whatever the
    // killed child said on its way out — "opencode exited with code null: …" for a deliberate
    // Ctrl-C — and both `orch show` and the web console render `failed_stage` + `error_message`
    // verbatim, so recording them made every intentional cancel read as a run that failed in
    // Execute. Cleared rather than left alone: a stage may have recorded them before the cancel.
    setStatus(runId, "cancelled", { error_message: null, failed_stage: null });
  } else {
    setStatus(runId, "failed", { error_message: message, failed_stage: stage });
    emitRunEvent(runId, {
      type: "stage_failed",
      stage,
      message,
      timedOut: err instanceof StageTimeoutError,
    });
  }
  await finalizeTerminal(getRun(runId)!);
}

/** Spec §10 project selection + §5 branch naming: creates the DB row; caller still needs to `startRun`. */
export function createNewRun(input: { projectPath: string; task: string; autoApprove: boolean }): Run {
  const id = randomUUID();
  return createRun({
    id,
    project_path: input.projectPath,
    task: input.task,
    branch_name: `orchestrator/${id}`,
    auto_approve: input.autoApprove,
  });
}

/** Spec §3.1: sets up the run's worktree and runs the Plan stage. */
export async function startRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  try {
    // owner_pid is stamped *before* the worktree is created, not with it. `git worktree add` takes
    // real time on a large repo, and a cancel arriving in that window used to find owner_pid still
    // null: cancelRun failed its `owner_pid === process.pid` test, took the fall-through, and wrote
    // a terminal `cancelled` row — while this function carried on and wrote owner_pid and
    // worktree_path back onto it, leaving a row no command could clean up and a worktree on disk.
    // Stamped first, the same cancel takes the owner branch (flag and return), the row stays
    // `planning`, and runStage's throwIfCancelled converts it through failRun, which removes the
    // worktree that by then exists. The write-back below is what makes that removal possible.
    updateRun(run.id, { owner_pid: process.pid });
    const { worktreePath } = await createRunWorktree(run.project_path, run.id);
    updateRun(run.id, { worktree_path: worktreePath });

    const handle = runClaude({
      cwd: worktreePath,
      prompt: buildPlanPrompt(run.task),
      mode: "plan",
      onEvent: (event) => emitRunEvent(run.id, { type: "cli_event", stage: "plan", data: event }),
    });

    const started = Date.now();
    const stageResult = await runStage(run.id, handle);
    if (stageResult.isError) {
      throw new Error(`Plan stage reported an error: ${stageResult.resultText}`);
    }

    updateRun(run.id, {
      plan_text: stageResult.resultText,
      plan_original_text: stageResult.resultText,
      plan_duration_ms: stageResult.durationMs ?? Date.now() - started,
      plan_tokens_in: stageResult.tokensIn,
      plan_tokens_out: stageResult.tokensOut,
      plan_cost_usd: stageResult.costUsd,
    });

    // Spec §6: auto-approve (the default) skips straight to Execute; otherwise wait for /approve.
    // This chains into approvePlan, not approveRun: approveRun's job is to *check* that an outside
    // caller is allowed to approve, and this caller is the pipeline itself, which already knows.
    // Parking an auto-approve run at awaiting_approval just to satisfy that check would publish a
    // gate it does not have — setStatus emits a status_change over SSE, so a browser tab would
    // render the approve/reject controls, and the status stays awaiting_approval across
    // writePlanFileAndCommit's await, so a click landing in that window would pass approveRun's
    // guard and start a second plan commit and a second Execute on one worktree.
    if (run.auto_approve) {
      await approvePlan(run.id, stageResult.resultText);
    } else {
      setStatus(run.id, "awaiting_approval");
    }
  } catch (err) {
    await failRun(run.id, "plan", err);
  }
}

/**
 * Spec §6: the entry point for approving from *outside* the pipeline — a browser tab, `orch run`'s
 * gate, `orch resume`. Everything it adds over `approvePlan` is the permission check.
 *
 * R15: two processes can both reach this call for the same run (two browser tabs, a resumed CLI
 * racing the tab that already answered), and `approvePlan` has no status guard of its own — without
 * this one the second caller starts a second plan commit and a second Execute against a single
 * worktree. Guarded here rather than in the CLI because the web console has the identical race, and
 * refused before anything is written, the same way `closeRun` guards its own transition.
 */
export async function approveRun(runId: string, finalPlanText: string): Promise<void> {
  const refusal = approvalRefusal(runId);
  if (refusal) throw new Error(refusal);
  await approvePlan(runId, finalPlanText);
}

/**
 * `approveRun`'s permission check as a value rather than a throw, so a caller that cannot await
 * the answer can still ask the question. `approveRun` awaits the *entire* pipeline — approvePlan
 * chains into runExecuteAndReview — so `POST /approve` cannot learn the verdict by awaiting it
 * without holding the HTTP response open for the whole run. It calls this instead, in the same
 * tick as `approveRun`; with no await in between, nothing can move the row in the gap, so the
 * answer the browser is given and the decision the pipeline makes cannot disagree.
 *
 * Status is tested before `worktree_path` deliberately: `finalizeTerminal` nulls `worktree_path`,
 * so a terminal run fails both tests and the ordering decides which reason the user is told.
 * "cannot be approved from status approved" is the true one; "has no active worktree" describes a
 * consequence and reads like corruption.
 */
export function approvalRefusal(runId: string): string | null {
  const run = getRun(runId);
  if (!run) return `Run not found: ${runId}`;
  if (run.status !== "awaiting_approval") {
    return `Run ${runId} cannot be approved from status ${run.status}`;
  }
  if (!run.worktree_path) return `Run ${runId} has no active worktree to approve into`;
  return null;
}

/** Commits the — possibly user-edited — plan and starts Execute. Assumes the caller may do this. */
async function approvePlan(runId: string, finalPlanText: string): Promise<void> {
  const run = getRun(runId);
  if (!run?.worktree_path) throw new Error(`Run ${runId} has no active worktree to approve into`);

  // Closes the race where auto-approve chains straight from Plan into this git commit — if cancel
  // landed in that gap, no process was registered for gracefulStop to signal (see throwIfCancelled).
  if (isCancelled(runId)) {
    await failRun(runId, "plan", new RunCancelledError(`Run ${runId} was cancelled`));
    return;
  }

  // Whoever approves now drives the run — the CLI may be resuming one the web app started.
  updateRun(runId, { owner_pid: process.pid });

  // writePlanFileAndCommit throws on any git failure (git.ts runGit). Without this catch the
  // error escapes approveRun entirely, bypasses failRun, and leaves the run at
  // awaiting_approval with a live worktree and nothing recorded anywhere.
  let planCommitSha: string;
  try {
    planCommitSha = await writePlanFileAndCommit(run.worktree_path, finalPlanText);
  } catch (err) {
    await failRun(runId, "plan", err);
    return;
  }
  updateRun(runId, { plan_text: finalPlanText, plan_commit_sha: planCommitSha });
  await runExecuteAndReview(runId, finalPlanText, undefined);
}

/** Spec §3.2 + §3.3 + §7: runs Execute then Review, and records the outcome. */
async function runExecuteAndReview(
  runId: string,
  planText: string,
  retryFeedback: string | undefined,
): Promise<void> {
  let stage: "execute" | "review" = "execute";
  try {
    throwIfCancelled(runId);
    const run = getRun(runId)!;
    const worktreePath = run.worktree_path!;

    setStatus(runId, "executing");
    const executeHandle = runOpenCode({
      cwd: worktreePath,
      prompt: buildExecutePrompt(planText, retryFeedback),
      model: OPENCODE_MODEL,
      onEvent: (event) => emitRunEvent(runId, { type: "cli_event", stage: "execute", data: event }),
    });
    const executeStarted = Date.now();
    const executeResult = await runStage(runId, executeHandle);
    updateRun(runId, {
      execute_duration_ms: Date.now() - executeStarted,
      execute_tokens_in: executeResult.tokensIn,
      execute_tokens_out: executeResult.tokensOut,
      execute_cost_usd: executeResult.costUsd,
    });

    const diffText = await computeDiff(worktreePath, run.plan_commit_sha!);
    updateRun(runId, { diff_text: diffText });
    // Bugfix: without this, Execute's edits only ever exist as uncommitted worktree state, and
    // get silently discarded by removeRunWorktree the moment the run reaches a terminal state.
    await commitExecuteChanges(worktreePath);

    stage = "review";
    throwIfCancelled(runId);
    setStatus(runId, "reviewing");
    const reviewHandle = runClaude({
      cwd: worktreePath,
      prompt: buildReviewPrompt(planText, diffText),
      mode: "review",
      onEvent: (event) => emitRunEvent(runId, { type: "cli_event", stage: "review", data: event }),
    });
    const reviewStarted = Date.now();
    const reviewResult = await runStage(runId, reviewHandle);
    if (reviewResult.isError) {
      throw new Error(`Review stage reported an error: ${reviewResult.resultText}`);
    }

    const { verdict, reasoning } = parseVerdict(reviewResult.resultText);
    updateRun(runId, {
      verdict,
      review_reasoning: reasoning,
      review_duration_ms: reviewResult.durationMs ?? Date.now() - reviewStarted,
      review_tokens_in: reviewResult.tokensIn,
      review_tokens_out: reviewResult.tokensOut,
      review_cost_usd: reviewResult.costUsd,
    });

    if (verdict === "APPROVE") {
      setStatus(runId, "approved");
      await finalizeTerminal(getRun(runId)!);
    } else {
      // Spec §7: non-blocking — the run sits here until the user retries, closes, or cancels it.
      setStatus(runId, "needs_changes");
    }
    emitRunEvent(runId, { type: "run_completed", verdict });
  } catch (err) {
    await failRun(runId, stage, err);
  }
}

/** Spec §7: re-runs Execute on the same branch with Review's feedback appended, capped at 3 cycles. */
export async function retryExecute(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status !== "needs_changes") throw new Error(`Run ${runId} is not awaiting retry`);
  if (run.retry_count >= RETRY_CAP) {
    throw new Error(`Run ${runId} has reached the retry cap (${RETRY_CAP}) — edit the plan or close it manually.`);
  }

  updateRun(runId, { retry_count: run.retry_count + 1, owner_pid: process.pid });
  await runExecuteAndReview(runId, run.plan_text ?? "", run.review_reasoning ?? undefined);
}

/** Spec §6: rejecting at the approval gate, before Execute ever runs. */
export async function rejectRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  // R15: same guard as approveRun, same reason — rejecting is destructive (finalizeTerminal), and
  // without this a run that already moved past the gate would happily get "rejected" out from
  // under whatever is now driving it.
  if (run.status !== "awaiting_approval") {
    throw new Error(`Run ${runId} cannot be rejected from status ${run.status}`);
  }
  setStatus(runId, "cancelled");
  await finalizeTerminal(getRun(runId)!);
}

/** Spec §7: closing a `needs_changes` run without retrying further. */
export async function closeRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status !== "needs_changes") throw new Error(`Run ${runId} cannot be closed from status ${run.status}`);
  setStatus(runId, "closed_needs_changes");
  await finalizeTerminal(getRun(runId)!);
}

/** A run another live process is driving. Only that process can stop its child cleanly. */
export class RunOwnedElsewhereError extends Error {}

/**
 * Spec §8: graceful SIGTERM/SIGKILL if a stage is mid-flight here, otherwise close the run out.
 *
 * The four cases are genuinely different. A stage live in *this* process can be signalled, and
 * the owning promise will reach failRun on its own. A run whose owner is a different live process
 * must be refused — finalizeTerminal deletes worktrees outright, and doing that under someone
 * else's running Execute destroys uncommitted work. A run we own with no stage currently
 * registered is still mid-flight *in this process* (between two stages, e.g. inside computeDiff /
 * commitExecuteChanges) — finalizeTerminal must not touch it either, for the same worktree-deletion
 * reason, so it's flagged and left for the pipeline's own throwIfCancelled/runStage to convert.
 * Everything else (parked, or stranded by a dead owner) is ours to close out; before this, the
 * early return below left stranded runs stuck in an active status with their worktree on disk
 * forever.
 */
export async function cancelRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (TERMINAL_STATUSES.includes(run.status)) return;

  if (ACTIVE_STATUSES.includes(run.status)) {
    if (hasLiveStage(runId)) {
      markCancelled(runId);
      // The in-flight stage's promise rejects once the process exits; failRun() sees
      // isCancelled() and records "cancelled" instead of "failed".
      await gracefulStop(runId);
      return;
    }
    // Our own pid is not "somewhere else" — this is the Ctrl-C path landing in the gap between
    // two stages, where no controller is registered but we are still the owner.
    if (run.owner_pid !== process.pid && isPidAlive(run.owner_pid)) {
      throw new RunOwnedElsewhereError(
        `Run ${runId} is being driven by another process (pid ${run.owner_pid}). ` +
          `Press Ctrl-C in that terminal to cancel it.`,
      );
    }
    // We own this run and a pipeline is still driving it here, just between stages. Flag it and
    // let throwIfCancelled/runStage convert it to "cancelled" once the in-flight git work
    // finishes: finalizeTerminal would delete the worktree out from under that git command, and
    // clearController would erase the very flag the pipeline is about to check.
    if (run.owner_pid === process.pid) {
      markCancelled(runId);
      return;
    }
  }

  setStatus(runId, "cancelled");
  await finalizeTerminal(getRun(runId)!);
  // Set after finalizeTerminal, not before: finalizeTerminal -> clearController deletes this same
  // flag from the cancelledRuns set, so setting it first would just have it erased. A stranded run
  // (including a pre-owner_pid-migration row, where owner_pid is null and not "===" to anything)
  // still needs to end up flagged cancelled for any late-arriving isCancelled() check.
  markCancelled(runId);
}
