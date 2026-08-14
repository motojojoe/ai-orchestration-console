import {
  ACTIVE_STATUSES,
  GATE_STATUSES,
  UNFINISHED_STATUSES,
  findUnfinishedRuns,
  getRun,
  listRuns,
  type Run,
} from "../lib/db";
import { validateProject } from "../lib/git";
import { isPidAlive } from "../lib/orchestrator/control";
import { subscribeRunEvents } from "../lib/orchestrator/events";
import {
  RunOwnedElsewhereError,
  approveRun,
  cancelRun,
  closeRun,
  createNewRun,
  rejectRun,
  retryExecute,
  startRun,
} from "../lib/orchestrator/pipeline";
import { checkCredentials } from "../lib/preflight";
import { EXIT, exitCodeForStatus } from "./exit-codes";
import { notifyRunFinished } from "./notify";
import { ask, editText } from "./prompt";
import { renderEvent } from "./render";

function fmtCost(n: number | null): string {
  return n === null ? "—" : `$${n.toFixed(4)}`;
}

function fmtDuration(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

export async function list(): Promise<number> {
  const runs = listRuns(20);
  if (runs.length === 0) {
    process.stdout.write("No runs yet.\n");
    return EXIT.OK;
  }
  for (const run of runs) {
    const task = run.task.length > 48 ? `${run.task.slice(0, 47)}…` : run.task;
    process.stdout.write(
      `${run.id.slice(0, 8)}  ${run.status.padEnd(20)}  ${run.created_at.slice(0, 16)}  ${task}\n`,
    );
  }
  return EXIT.OK;
}

export async function show(id: string): Promise<number> {
  const run = getRun(id);
  if (!run) {
    process.stderr.write(`Run not found: ${id}\n`);
    return EXIT.USAGE;
  }
  const lines: [string, string][] = [
    ["id", run.id],
    ["task", run.task],
    ["project", run.project_path],
    ["status", run.status],
    ["branch", run.branch_name],
    ["verdict", run.verdict ?? "—"],
    ["retries", String(run.retry_count)],
    ["plan", `${fmtDuration(run.plan_duration_ms)}  ${fmtCost(run.plan_cost_usd)}`],
    ["execute", `${fmtDuration(run.execute_duration_ms)}  ${fmtCost(run.execute_cost_usd)}`],
    ["review", `${fmtDuration(run.review_duration_ms)}  ${fmtCost(run.review_cost_usd)}`],
  ];
  for (const [label, value] of lines) {
    process.stdout.write(`${label.padEnd(9)} ${value}\n`);
  }
  if (run.error_message) {
    process.stdout.write(`\nerror (${run.failed_stage ?? "?"}): ${run.error_message}\n`);
  }
  if (run.review_reasoning) {
    process.stdout.write(`\n${run.review_reasoning}\n`);
  }
  return EXIT.OK;
}

export async function doctor(): Promise<number> {
  const result = await checkCredentials();
  if (!result.ok) {
    process.stderr.write(`✗ ${result.reason}\n`);
    return EXIT.USAGE;
  }
  process.stdout.write("✓ claude and opencode are both authenticated\n");
  return EXIT.OK;
}

/**
 * SPEC §1 says one pipeline at a time, and nothing in the code enforces it. This is advisory: two
 * `orch run` invocations racing between here and createRun can still both proceed. It narrows the
 * window and, more usefully, makes a stranded run visible with its remedy.
 *
 * The question asked is `findUnfinishedRuns`, not `findActiveRuns`: "a stage is running" is too
 * narrow. A run parked at `awaiting_approval` or `needs_changes` is where a run spends most of its
 * wall-clock time and is by far the likeliest thing to be stranded — close the terminal while
 * reading a plan and the row keeps a dead `owner_pid` and its worktree under
 * `.orchestrator-worktrees/` with nothing pointing at it. Checking only active statuses let a
 * second pipeline start on top of exactly that.
 */
function assertNoUnfinishedRun(): string | null {
  const [busy] = findUnfinishedRuns();
  if (!busy) return null;
  const short = busy.id.slice(0, 8);
  const atGate = GATE_STATUSES.includes(busy.status);

  // A live owner is a legitimately busy run, not a stranded one — including at a gate, where the
  // owner is simply sitting at a prompt in another terminal.
  if (isPidAlive(busy.owner_pid)) {
    const where = atGate ? " — answer the prompt in that terminal" : "";
    return `Run ${short} is already ${busy.status} (pid ${busy.owner_pid})${where}.`;
  }

  // owner_pid dead, or null (a row written before the owner_pid migration): nobody is driving it.
  const remedy = atGate
    ? `Clear it with: orch cancel ${busy.id} — or pick it back up with: orch resume ${busy.id}`
    : `Clear it with: orch cancel ${busy.id}`;
  return `Run ${short} is stuck at ${busy.status} — its process is gone. ${remedy}`;
}

/**
 * Prints the branch and cost once a run reaches a terminal state.
 *
 * The diff hint deliberately does not name a base branch. The run's base is whatever `HEAD` was
 * when `git worktree add` ran, which is not necessarily `main` — this repo's own workflow branches
 * off `develop` — so a hardcoded `git diff main..<branch>` prints a command that quietly shows the
 * wrong range. `plan_commit_sha` is a fact about this run, recorded on the row, and diffing from
 * it is exactly the range Review was shown (`computeDiff` uses the same base). If the run never
 * got that far, there is nothing true to suggest, so nothing is printed.
 */
function printSummary(run: Run): void {
  const cost = [run.plan_cost_usd, run.execute_cost_usd, run.review_cost_usd]
    .filter((c): c is number => c !== null)
    .reduce((a, b) => a + b, 0);
  process.stdout.write(`\n${run.status}${run.verdict ? ` (${run.verdict})` : ""}\n`);
  if (run.error_message) process.stdout.write(`${run.error_message}\n`);
  if (run.review_reasoning) process.stdout.write(`\n${run.review_reasoning}\n`);
  process.stdout.write(`\nbranch  ${run.branch_name}\ncost    $${cost.toFixed(4)}\n`);
  if (run.plan_commit_sha) {
    process.stdout.write(
      `\n  git diff ${run.plan_commit_sha.slice(0, 12)}..${run.branch_name}   # what Execute changed\n`,
    );
  }
}

/**
 * Drives a run from wherever it currently is to a terminal state, prompting at each human gate.
 * `track` is handed each pipeline promise so the SIGINT handler can await it rather than race it.
 */
export async function driveToTerminal(
  runId: string,
  track: (p: Promise<void>) => Promise<void>,
): Promise<number> {
  for (;;) {
    const run = getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    if (run.status === "awaiting_approval") {
      let planText = run.plan_text ?? "";
      process.stdout.write(`\n${planText}\n`);
      const choice = await ask("Approve this plan?", ["a", "e", "r"]);
      if (choice === "r") {
        try {
          // A status that moved underneath the CLI (another process already answered this gate,
          // or the run's worktree is gone) is a user-facing constraint, not a pipeline failure —
          // same reasoning as the needs_changes branch below. `ask`/`editText` stay outside every
          // try/catch here: prompt.ts's SIGINT unwinding is do-not-touch.
          await track(rejectRun(runId));
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          return EXIT.USAGE;
        }
        continue;
      }
      if (choice === "e") {
        const edited = await editText(planText);
        if (!edited.ok) {
          process.stdout.write(`${edited.reason}\n`);
          continue;
        }
        planText = edited.text;
      }
      try {
        await track(approveRun(runId, planText));
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        return EXIT.USAGE;
      }
      continue;
    }

    if (run.status === "needs_changes") {
      process.stdout.write(`\n${run.review_reasoning ?? "(no reasoning recorded)"}\n`);
      const choice = await ask("Retry Execute with this feedback?", ["r", "c"]);
      try {
        // Both throw for the same reason — a status that moved underneath the CLI (and
        // retryExecute additionally for the retry cap) — so both are caught the same way.
        // Leaving `closeRun` unwrapped let that stack escape all the way to index.ts.
        if (choice === "r") await track(retryExecute(runId));
        else await track(closeRun(runId));
      } catch (err) {
        // A user-facing constraint, not a pipeline failure: nothing was recorded as failed.
        process.stderr.write(`${(err as Error).message}\n`);
        return EXIT.USAGE;
      }
      continue;
    }

    printSummary(run);
    notifyRunFinished(run.task, run.status);
    return exitCodeForStatus(run.status);
  }
}

export async function run(task: string, projectPath: string): Promise<number> {
  const project = await validateProject(projectPath);
  if (!project.ok) {
    process.stderr.write(`${project.reason}\n`);
    return EXIT.USAGE;
  }
  const creds = await checkCredentials();
  if (!creds.ok) {
    process.stderr.write(`${creds.reason}\n`);
    return EXIT.USAGE;
  }
  const busy = assertNoUnfinishedRun();
  if (busy) {
    process.stderr.write(`${busy}\n`);
    return EXIT.USAGE;
  }

  // autoApprove is always false: with true, startRun chains straight into approveRun internally
  // and leaves no point at which to insert the approval prompt.
  const created = createNewRun({ projectPath, task, autoApprove: false });
  process.stdout.write(`run ${created.id}\nbranch ${created.branch_name}\n\n`);

  const unsubscribe = subscribeRunEvents(created.id, (event) => {
    const line = renderEvent(event);
    if (line) process.stdout.write(line);
  });

  const { track, install } = installSignalHandler(created.id);
  const restore = install();
  try {
    await track(startRun(created.id));
    return await driveToTerminal(created.id, track);
  } finally {
    restore();
    unsubscribe();
  }
}

/**
 * Ctrl-C during a run. `await cancelRun(id); process.exit(130)` loses a race: gracefulStop sends
 * SIGTERM, waits a fixed five seconds, sends SIGKILL, and never awaits the child's close event or
 * the pipeline promise — so exiting when it returns can beat the "cancelled" status write and the
 * worktree removal, stranding exactly the state the cancel was meant to clean up. Awaiting the
 * outstanding pipeline promise closes that. The second Ctrl-C is the escape hatch, and the timer
 * is the one for a pipeline promise that never settles.
 */
function installSignalHandler(runId: string): {
  track: (p: Promise<void>) => Promise<void>;
  install: () => () => void;
} {
  let inFlight: Promise<void> = Promise.resolve();
  let cancelling = false;

  const track = async (p: Promise<void>): Promise<void> => {
    inFlight = p.catch(() => {});
    return p;
  };

  const onSigint = (): void => {
    if (cancelling) process.exit(EXIT.INTERRUPTED);
    cancelling = true;
    process.stdout.write("\ncancelling — press Ctrl-C again to force\n");

    const forceExit = setTimeout(() => process.exit(EXIT.INTERRUPTED), 30_000);
    forceExit.unref();

    void (async () => {
      try {
        await cancelRun(runId);
        await inFlight;
      } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
      }
      process.exit(EXIT.INTERRUPTED);
    })();
  };

  return {
    track,
    install: () => {
      process.on("SIGINT", onSigint);
      return () => process.off("SIGINT", onSigint);
    },
  };
}

export async function resume(id: string): Promise<number> {
  const run = getRun(id);
  if (!run) {
    process.stderr.write(`Run not found: ${id}\n`);
    return EXIT.USAGE;
  }
  // R17: GATE_STATUSES (db.ts) is the one definition of "parked at a gate" — assertNoUnfinishedRun
  // already recommends `orch resume` based on it 180 lines up, so resume must accept on the same
  // list or the CLI can recommend a command that then refuses.
  if (!GATE_STATUSES.includes(run.status)) {
    const hint = ACTIVE_STATUSES.includes(run.status)
      ? ` A run left at ${run.status} has no live process here — clear it with: orch cancel ${id}`
      : "";
    process.stderr.write(`Run ${id} is ${run.status}, not parked at a gate.${hint}\n`);
    return EXIT.USAGE;
  }

  process.stdout.write(`run ${run.id}\nbranch ${run.branch_name}\n`);
  const unsubscribe = subscribeRunEvents(run.id, (event) => {
    const line = renderEvent(event);
    if (line) process.stdout.write(line);
  });
  const { track, install } = installSignalHandler(run.id);
  const restore = install();
  try {
    return await driveToTerminal(run.id, track);
  } finally {
    restore();
    unsubscribe();
  }
}

export async function cancel(id: string): Promise<number> {
  const run = getRun(id);
  if (!run) {
    process.stderr.write(`Run not found: ${id}\n`);
    return EXIT.USAGE;
  }
  // Minor 4: read the status before mutating anything. cancelRun early-returns a no-op on a
  // terminal status, so printing the post-call status unconditionally made `orch cancel <an
  // approved run>` print "approved" and exit 0 — reading as though the cancel produced that
  // state. Re-cancelling an already-cancelled run is still a safe no-op, just a clearer one.
  if (!UNFINISHED_STATUSES.includes(run.status)) {
    process.stdout.write(`Nothing to cancel — run is already ${run.status}\n`);
    return EXIT.OK;
  }
  try {
    await cancelRun(id);
  } catch (err) {
    // A run another live process is driving is a refusal, not a failure: finalizeTerminal deletes
    // worktrees outright, and doing that under someone else's Execute destroys uncommitted work.
    if (err instanceof RunOwnedElsewhereError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT.USAGE;
    }
    throw err;
  }
  process.stdout.write(`${getRun(id)!.status}\n`);
  return EXIT.OK;
}
