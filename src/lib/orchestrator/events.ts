import { EventEmitter } from "node:events";
import type { NdjsonEvent } from "../cli/process";
import type { RunStatus } from "../db";

export type RunEvent =
  | { type: "cli_event"; stage: "plan" | "execute" | "review"; data: NdjsonEvent }
  | { type: "status_change"; status: RunStatus }
  | { type: "stage_failed"; stage: "plan" | "execute" | "review"; message: string; timedOut: boolean }
  | { type: "run_completed"; verdict: "APPROVE" | "NEEDS_CHANGES" };

// Stashed on globalThis, not a plain module-level variable: Next.js dev-mode hot-reload can
// re-evaluate this file's top level independently per route (e.g. once for the route that starts
// a run, again for the SSE route that subscribes to it) — a plain `const emitters = new Map()`
// would give each of those its own Map, so events emitted from one never reach the other's
// subscribers. globalThis is the one thing guaranteed to be the same object across all of them
// within a single Node process.
const g = globalThis as unknown as { __orchestratorEmitters?: Map<string, EventEmitter> };
const emitters = (g.__orchestratorEmitters ??= new Map<string, EventEmitter>());

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
