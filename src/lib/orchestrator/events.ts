import { EventEmitter } from "node:events";
import type { NdjsonEvent } from "../cli/process";
import type { RunStatus } from "../db";

export type RunEvent =
  | { type: "cli_event"; stage: "plan" | "execute" | "review"; data: NdjsonEvent }
  | { type: "status_change"; status: RunStatus }
  | { type: "stage_failed"; stage: "plan" | "execute" | "review"; message: string; timedOut: boolean }
  | { type: "run_completed"; verdict: "APPROVE" | "NEEDS_CHANGES" };

const emitters = new Map<string, EventEmitter>();

function getEmitter(runId: string): EventEmitter {
  let e = emitters.get(runId);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(20);
    emitters.set(runId, e);
  }
  return e;
}

export function emitRunEvent(runId: string, event: RunEvent): void {
  getEmitter(runId).emit("event", event);
}

export function subscribeRunEvents(runId: string, listener: (event: RunEvent) => void): () => void {
  const emitter = getEmitter(runId);
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}
