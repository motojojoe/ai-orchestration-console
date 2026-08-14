import { execFile } from "node:child_process";
import type { RunStatus } from "../lib/db";

/** macOS only; silent everywhere else. Fire-and-forget — a failed notification must not matter. */
function display(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  const escape = (s: string) => s.replace(/["\\]/g, "\\$&");
  execFile(
    "osascript",
    ["-e", `display notification "${escape(body)}" with title "${escape(title)}"`],
    () => {},
  );
}

export function notifyRunFinished(task: string, status: RunStatus): void {
  const short = task.length > 40 ? `${task.slice(0, 39)}…` : task;
  if (status === "approved") display(`✅ ${short}`, "Done, ready to merge.");
  else if (status === "failed") display(`⚠️ ${short}`, "A stage failed — needs a look.");
  else display(`⚠️ ${short}`, `Finished as ${status}.`);
}
