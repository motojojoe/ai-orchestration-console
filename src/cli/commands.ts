import { ACTIVE_STATUSES, findActiveRuns, getRun, listRuns, type Run, type RunStatus } from "../lib/db";
import { validateProject } from "../lib/git";
import { isPidAlive } from "../lib/orchestrator/control";
import { subscribeRunEvents } from "../lib/orchestrator/events";
import {
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
 */
function assertNoActiveRun(): string | null {
  const [active] = findActiveRuns();
  if (!active) return null;
  if (isPidAlive(active.owner_pid)) {
    return `Run ${active.id.slice(0, 8)} is already ${active.status} (pid ${active.owner_pid}).`;
  }
  return (
    `Run ${active.id.slice(0, 8)} is stuck at ${active.status} — its process is gone. ` +
    `Clear it with: orch cancel ${active.id}`
  );
}

/** Prints the branch and cost once a run reaches a terminal state. */
function printSummary(run: Run): void {
  const cost = [run.plan_cost_usd, run.execute_cost_usd, run.review_cost_usd]
    .filter((c): c is number => c !== null)
    .reduce((a, b) => a + b, 0);
  process.stdout.write(`\n${run.status}${run.verdict ? ` (${run.verdict})` : ""}\n`);
  if (run.error_message) process.stdout.write(`${run.error_message}\n`);
  if (run.review_reasoning) process.stdout.write(`\n${run.review_reasoning}\n`);
  process.stdout.write(`\nbranch  ${run.branch_name}\ncost    $${cost.toFixed(4)}\n`);
  process.stdout.write(`\n  git diff main..${run.branch_name}\n`);
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
        await track(rejectRun(runId));
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
      await track(approveRun(runId, planText));
      continue;
    }

    if (run.status === "needs_changes") {
      process.stdout.write(`\n${run.review_reasoning ?? "(no reasoning recorded)"}\n`);
      const choice = await ask("Retry Execute with this feedback?", ["r", "c"]);
      if (choice === "r") {
        try {
          await track(retryExecute(runId));
        } catch (err) {
          // Retry cap, or a status that moved underneath us. Not a pipeline failure.
          process.stderr.write(`${(err as Error).message}\n`);
          return EXIT.USAGE;
        }
      } else {
        await track(closeRun(runId));
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
  const busy = assertNoActiveRun();
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
