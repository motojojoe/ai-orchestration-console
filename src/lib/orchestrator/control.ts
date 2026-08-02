interface StageController {
  kill: ((signal: NodeJS.Signals) => void) | null;
}

const controllers = new Map<string, StageController>();
const cancelledRuns = new Set<string>();

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
    return await Promise.race([handle.result, timeout]);
  } finally {
    controller.kill = null;
  }
}
