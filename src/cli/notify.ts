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
  // Collapsed to one line before truncating, because the task is interpolated into an AppleScript
  // string literal in `display`. Note what this does *not* claim: on macOS 27 / osascript here, a
  // literal newline inside that string is accepted and exits 0 — the "newline makes it a syntax
  // error, so the notification silently never appears" story does not reproduce, so do not repeat
  // it. What is left is smaller and true: a notification title is a single line of chrome, and
  // truncating at 40 characters of a multi-line string measures the wrong thing.
  const oneLine = task.replace(/\s+/g, " ").trim();
  const short = oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine;
  if (status === "approved") display(`✅ ${short}`, "Done, ready to merge.");
  else if (status === "failed") display(`⚠️ ${short}`, "A stage failed — needs a look.");
  else display(`⚠️ ${short}`, `Finished as ${status}.`);
}
