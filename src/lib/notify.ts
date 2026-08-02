/** Spec §8 + §12: desktop notifications for stage failures/timeouts and run completion, on by default. */

export function requestNotificationPermission(): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

export function notify(title: string, body: string): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  new Notification(title, { body });
}

export function notifyStageFailed(task: string, stage: string, timedOut: boolean): void {
  const reason = timedOut ? "timed out" : "failed";
  const stageLabel = stage.charAt(0).toUpperCase() + stage.slice(1);
  notify(`⚠️ ${task}`, `${stageLabel} stage ${reason} — needs a look.`);
}

export function notifyRunCompleted(task: string, verdict: "APPROVE" | "NEEDS_CHANGES"): void {
  if (verdict === "APPROVE") {
    notify(`✅ ${task}`, "Done, ready to merge.");
  } else {
    notify(`⚠️ ${task}`, "Review flagged issues, needs a look.");
  }
}
