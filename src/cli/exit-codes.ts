import type { RunStatus } from "../lib/db";

export const EXIT = {
  OK: 0,
  /** The pipeline ran to completion; the result was not approved. */
  NOT_APPROVED: 1,
  /** A stage errored or timed out. */
  FAILED: 2,
  /** Bad usage, failed pre-flight, or any thrown guard. */
  USAGE: 64,
  /** Terminated by Ctrl-C — and only that. */
  INTERRUPTED: 130,
} as const;

/**
 * `needs_changes` is absent on purpose: it is not in the pipeline's TERMINAL_STATUSES, and the
 * run flow always resolves it to a retry or a close before exiting. Arriving here with it means
 * the flow has a hole, so this throws rather than inventing a code.
 */
export function exitCodeForStatus(status: RunStatus): number {
  switch (status) {
    case "approved":
      return EXIT.OK;
    case "closed_needs_changes":
      return EXIT.NOT_APPROVED;
    case "failed":
      return EXIT.FAILED;
    case "cancelled":
      return EXIT.INTERRUPTED;
    default:
      throw new Error(`${status} is not a terminal status — nothing should be exiting on it`);
  }
}
