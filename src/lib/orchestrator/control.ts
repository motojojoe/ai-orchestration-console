interface StageController {
  kill: ((signal: NodeJS.Signals) => void) | null;
}

// Same globalThis-stashing reason as in events.ts: this state must survive independent module
// re-evaluation across routes under Next.js dev-mode hot-reload (e.g. the route that runs a stage
// vs. the route that later tries to cancel it) — a plain module-level Map/Set risks the cancel
// request finding an empty registry and silently doing nothing.
const g = globalThis as unknown as {
  __orchestratorControllers?: Map<string, StageController>;
  __orchestratorCancelledRuns?: Set<string>;
};
const controllers = (g.__orchestratorControllers ??= new Map<string, StageController>());
const cancelledRuns = (g.__orchestratorCancelledRuns ??= new Set<string>());

function getController(runId: string): StageController {
  let c = controllers.get(runId);
  if (!c) {
    c = { kill: null };
    controllers.set(runId, c);
  }
  return c;
}

export function clearController(runId: string): void {
  controllers.delete(runId);
  cancelledRuns.delete(runId);
}

export function markCancelled(runId: string): void {
  cancelledRuns.add(runId);
}

export function isCancelled(runId: string): boolean {
  return cancelledRuns.has(runId);
}

/**
 * Call before spawning a new stage. Closes the race where cancel lands in the gap between two
 * stages (e.g. while the plan commit or diff computation is running) — at that instant there's no
 * live process for `gracefulStop` to signal, so without this check the next stage would start
 * anyway, unaware a cancel was ever requested.
 */
export function throwIfCancelled(runId: string): void {
  if (isCancelled(runId)) {
    throw new RunCancelledError(`Run ${runId} was cancelled`);
  }
}

/** Spec §8: SIGTERM first, wait up to 5s, then SIGKILL. Shared by explicit cancel and stage timeouts. */
export async function gracefulStop(runId: string): Promise<void> {
  const c = controllers.get(runId);
  if (!c?.kill) return;
  c.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 5000));
  c.kill?.("SIGKILL");
}

export const DEFAULT_STAGE_TIMEOUT_MS = 15 * 60 * 1000;

export class StageTimeoutError extends Error {}
export class RunCancelledError extends Error {}

/**
 * Runs a CLI stage under the per-stage timeout (spec §8, default 15 min). Registers the stage's
 * kill function so `cancelRun` can reach it while it's in flight.
 */
export async function runStage<T>(
  runId: string,
  handle: { result: Promise<T>; kill: (signal: NodeJS.Signals) => void },
  timeoutMs = DEFAULT_STAGE_TIMEOUT_MS,
): Promise<T> {
  const controller = getController(runId);
  controller.kill = handle.kill;

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      void gracefulStop(runId);
      reject(new StageTimeoutError(`Stage timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    // Let the process exit naturally if the stage finishes first — this timer alone shouldn't hold it open.
    timer.unref?.();
  });

  try {
    const result = await Promise.race([handle.result, timeout]);
    // A killed CLI can still exit "successfully" (e.g. OpenCode catches SIGTERM and exits 0) —
    // check the cancellation flag ourselves rather than trusting the process's own exit code.
    if (isCancelled(runId)) {
      throw new RunCancelledError(`Run ${runId} was cancelled`);
    }
    return result;
  } finally {
    controller.kill = null;
  }
}

/**
 * Whether a stage of this run is in flight *in this process*. `gracefulStop` returns silently
 * when nothing is registered, which reads identically to having stopped something — callers that
 * need to tell those apart (cancel, above all) must ask this first.
 */
export function hasLiveStage(runId: string): boolean {
  return controllers.get(runId)?.kill != null;
}

/**
 * Whether a process id still exists. Signal 0 performs the permission and existence checks
 * without delivering a signal; EPERM means it exists but is owned by someone else, which for our
 * purposes is alive. PID reuse could in principle make a dead owner look alive — for a
 * single-user local tool the consequence is a refusal the user can work around, not data loss.
 */
export function isPidAlive(pid: number | null): boolean {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
