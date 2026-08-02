"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Run, RunStatus } from "@/lib/db";
import { notifyRunCompleted, notifyStageFailed, requestNotificationPermission } from "@/lib/notify";

type Stage = "plan" | "execute" | "review";

const STEP_ORDER: { key: Stage; label: string }[] = [
  { key: "plan", label: "Plan" },
  { key: "execute", label: "Execute" },
  { key: "review", label: "Review" },
];

const STAGE_ORDER: Record<Stage, number> = { plan: 0, execute: 1, review: 2 };

/** Which stage is currently running (or, once the pipeline is past it, the last one that ran). */
function currentStage(status: RunStatus): Stage {
  switch (status) {
    case "planning":
    case "awaiting_approval":
      return "plan";
    case "executing":
      return "execute";
    case "reviewing":
    case "needs_changes":
    case "approved":
    case "closed_needs_changes":
      return "review";
    case "failed":
    case "cancelled":
      return "plan"; // overridden by run.failed_stage in stepState when available
  }
}

function stepState(
  run: Pick<Run, "status" | "failed_stage">,
  step: Stage,
): "done" | "active" | "bad" | "pending" {
  const { status } = run;
  const failedOrCancelled = status === "failed" || status === "cancelled";
  const stoppedAt = failedOrCancelled && run.failed_stage ? run.failed_stage : currentStage(status);
  const inProgress = status === "planning" || status === "executing" || status === "reviewing";
  const reviewFlagged = (status === "needs_changes" || status === "closed_needs_changes") && step === "review";

  if (failedOrCancelled) {
    if (step === stoppedAt) return "bad";
    return STAGE_ORDER[step] < STAGE_ORDER[stoppedAt] ? "done" : "pending";
  }
  if (reviewFlagged) return "bad";
  if (STAGE_ORDER[step] < STAGE_ORDER[stoppedAt]) return "done";
  if (STAGE_ORDER[step] === STAGE_ORDER[stoppedAt]) return inProgress ? "active" : "done";
  return "pending";
}

function formatCliEvent(stage: Stage, event: Record<string, unknown>): string | null {
  const type = event.type as string | undefined;
  if (stage === "plan" || stage === "review") {
    if (type === "assistant") {
      const message = event.message as { content?: { type: string; text?: string; name?: string }[] } | undefined;
      const content = message?.content ?? [];
      const text = content.find((c) => c.type === "text")?.text;
      if (text) return text;
      if (content.some((c) => c.type === "thinking")) return "… thinking";
      const tool = content.find((c) => c.type === "tool_use");
      if (tool?.name) return `→ ${tool.name}`;
    }
    return null;
  }
  if (stage === "execute") {
    if (type === "text") {
      const part = event.part as { text?: string } | undefined;
      return part?.text ?? null;
    }
    if (type === "step_start") return "→ working…";
  }
  return null;
}

function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <p style={{ color: "var(--ink-60)" }}>No changes.</p>;
  const lines = diff.split("\n");
  return (
    <div className="diff">
      {lines.map((line, i) => {
        let cls = "";
        if (line.startsWith("+") && !line.startsWith("+++")) cls = "diff-add";
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "diff-del";
        else if (line.startsWith("@@")) cls = "diff-hunk";
        return (
          <span key={i} className={cls}>
            {line || " "}
            {"\n"}
          </span>
        );
      })}
    </div>
  );
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
function fmtTokens(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
function fmtCost(n: number | null): string {
  if (n === null) return "—";
  return `$${n.toFixed(4)}`;
}

export default function RunView({ runId }: { runId: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [planDraft, setPlanDraft] = useState("");
  const [log, setLog] = useState<Record<Stage, string[]>>({ plan: [], execute: [], review: [] });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const notifiedRef = useRef(false);

  const refetch = useCallback(async () => {
    const res = await fetch(`/api/runs/${runId}`);
    if (!res.ok) return;
    const data = (await res.json()) as { run: Run };
    setRun(data.run);
    setPlanDraft((prev) => (prev ? prev : data.run.plan_text ?? ""));
  }, [runId]);

  useEffect(() => {
    requestNotificationPermission();
    void refetch();
  }, [refetch]);

  useEffect(() => {
    const source = new EventSource(`/api/runs/${runId}/events`);

    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as
        | { type: "connected" }
        | { type: "status_change"; status: RunStatus }
        | { type: "cli_event"; stage: Stage; data: Record<string, unknown> }
        | { type: "stage_failed"; stage: Stage; message: string; timedOut: boolean }
        | { type: "run_completed"; verdict: "APPROVE" | "NEEDS_CHANGES" };

      if (event.type === "status_change") {
        void refetch();
        if (event.status === "awaiting_approval") setPlanDraft((prev) => prev);
      } else if (event.type === "cli_event") {
        const line = formatCliEvent(event.stage, event.data);
        if (line) {
          setLog((prev) => ({ ...prev, [event.stage]: [...prev[event.stage], line] }));
        }
      } else if (event.type === "stage_failed") {
        notifyStageFailed(run?.task ?? "Run", event.stage, event.timedOut);
        void refetch();
      } else if (event.type === "run_completed") {
        if (!notifiedRef.current) {
          notifiedRef.current = true;
          notifyRunCompleted(run?.task ?? "Run", event.verdict);
        }
        void refetch();
      }
    };

    return () => source.close();
    // run.task is only used inside the handler for notification copy — resubscribing per keystroke isn't needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, refetch]);

  async function doAction(path: string, body?: unknown) {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/${path}`, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setActionError(data.error ?? "Action failed.");
      } else {
        await refetch();
      }
    } catch {
      setActionError("Couldn't reach the console's server.");
    } finally {
      setBusy(false);
    }
  }

  if (!run) {
    return (
      <main style={{ padding: "4rem", color: "var(--ink-60)" }}>Loading…</main>
    );
  }

  const statusPill: Record<RunStatus, { label: string; cls: string }> = {
    planning: { label: "planning", cls: "pill-active" },
    awaiting_approval: { label: "plan ready", cls: "pill-active" },
    executing: { label: "executing", cls: "pill-active" },
    reviewing: { label: "reviewing", cls: "pill-active" },
    needs_changes: { label: "needs changes", cls: "pill-bad" },
    approved: { label: "approved", cls: "pill-done" },
    closed_needs_changes: { label: "closed", cls: "pill-pending" },
    failed: { label: "failed", cls: "pill-bad" },
    cancelled: { label: "cancelled", cls: "pill-pending" },
  };

  const canCancel = ["planning", "awaiting_approval", "executing", "reviewing"].includes(run.status);
  const planDirty = planDraft !== (run.plan_original_text ?? "");

  return (
    <div className="layout-with-sidebar">
      <aside className="sidebar">
        <div className="field">
          <span className="eyebrow">Project</span>
          <span className="val mono">{run.project_path}</span>
        </div>
        <div className="field">
          <span className="eyebrow">Branch</span>
          <span className="val mono">{run.branch_name}</span>
        </div>
        <div className="field">
          <span className="eyebrow">Execute model</span>
          <span className="val mono">opencode/deepseek-v4-flash-free</span>
        </div>

        <nav className="stepper" aria-label="Pipeline progress">
          {STEP_ORDER.map((s) => {
            const state = stepState(run, s.key);
            const sub =
              state === "done" ? "done" : state === "active" ? "in progress…" : state === "bad" ? "failed" : "pending";
            return (
              <div key={s.key} className={`step ${state}`}>
                <span className="dot">{state === "done" ? "✓" : state === "bad" ? "✕" : STEP_ORDER.findIndex((x) => x.key === s.key) + 1}</span>
                <span className="label">
                  {s.label}
                  <span className="sub">{sub}</span>
                </span>
              </div>
            );
          })}
        </nav>

        <div className="sidebar-actions">
          {run.status === "awaiting_approval" && (
            <>
              <button className="btn btn-primary" disabled={busy} onClick={() => doAction("approve", { planText: planDraft })}>
                Approve &amp; run Execute
              </button>
              <button className="btn btn-danger-ghost" disabled={busy} onClick={() => doAction("reject")}>
                Reject run
              </button>
            </>
          )}
          {run.status === "needs_changes" && (
            <>
              <button
                className="btn btn-primary"
                disabled={busy || run.retry_count >= 3}
                onClick={() => doAction("retry")}
                title={run.retry_count >= 3 ? "Retry cap reached (3 cycles)" : undefined}
              >
                Retry Execute ({run.retry_count}/3)
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => doAction("close")}>
                Close anyway
              </button>
            </>
          )}
          {canCancel && (
            <button className="btn btn-danger-ghost" disabled={busy} onClick={() => doAction("cancel")}>
              Cancel run
            </button>
          )}
          {actionError && (
            <div style={{ fontSize: "0.8rem", color: "var(--bad)" }}>{actionError}</div>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="heading">
          <h1>{run.task}</h1>
          <span className={`pill ${statusPill[run.status].cls}`}>{statusPill[run.status].label}</span>
        </div>

        {run.error_message && (
          <div className="card bad">
            <h3>Error</h3>
            <p className="mono" style={{ fontSize: "0.85rem" }}>{run.error_message}</p>
          </div>
        )}

        {run.status === "awaiting_approval" && (
          <div className="editor-card">
            <div className="editor-card-head">
              <h3>Plan — editable before Execute runs</h3>
              {planDirty && <span className="dirty-flag">● edited</span>}
            </div>
            <p className="editor-hint">
              This is what Claude wrote to <code className="mono">.orchestrator/plan.md</code>. Edit
              anything below — Execute uses it exactly as you leave it.
            </p>
            <textarea
              className="editor mono"
              value={planDraft}
              onChange={(e) => setPlanDraft(e.target.value)}
              spellCheck={false}
            />
          </div>
        )}

        {(run.status === "planning" || run.status === "executing" || run.status === "reviewing") && (
          <div className="card">
            <h3>{run.status === "planning" ? "Plan" : run.status === "executing" ? "Execute" : "Review"} — live output</h3>
            <div className="log">
              {(log[run.status === "planning" ? "plan" : run.status === "executing" ? "execute" : "review"].join(
                "\n",
              ) || "waiting for output…")}
            </div>
          </div>
        )}

        {(run.status === "approved" || run.status === "needs_changes" || run.status === "closed_needs_changes") && (
          <>
            <div className={`card ${run.verdict === "APPROVE" ? "highlight" : "bad"}`}>
              <h3>Review verdict: {run.verdict}</h3>
              <p style={{ whiteSpace: "pre-wrap" }}>{run.review_reasoning}</p>
            </div>
            <div className="card">
              <h3>Diff</h3>
              <DiffView diff={run.diff_text ?? ""} />
            </div>
          </>
        )}

        {(run.plan_duration_ms !== null || run.execute_duration_ms !== null || run.review_duration_ms !== null) && (
          <div className="card">
            <h3>Observability</h3>
            <div className="metrics">
              <span>
                Plan: <b>{fmtMs(run.plan_duration_ms)}</b>
                {run.plan_tokens_in !== null && (
                  <>
                    {" · "}
                    <b>{fmtTokens(run.plan_tokens_in)} in / {fmtTokens(run.plan_tokens_out)} out</b>
                  </>
                )}
                {run.plan_cost_usd !== null && (
                  <>
                    {" · "}
                    <b>{fmtCost(run.plan_cost_usd)}</b>
                  </>
                )}
              </span>
              <span>
                Execute: <b>{fmtMs(run.execute_duration_ms)}</b>
                {run.execute_tokens_in !== null && (
                  <>
                    {" · "}
                    <b>{fmtTokens(run.execute_tokens_in)} in / {fmtTokens(run.execute_tokens_out)} out</b>
                  </>
                )}
                {run.execute_cost_usd !== null && (
                  <>
                    {" · "}
                    <b>{fmtCost(run.execute_cost_usd)}</b>
                  </>
                )}
              </span>
              <span>
                Review: <b>{fmtMs(run.review_duration_ms)}</b>
                {run.review_tokens_in !== null && (
                  <>
                    {" · "}
                    <b>{fmtTokens(run.review_tokens_in)} in / {fmtTokens(run.review_tokens_out)} out</b>
                  </>
                )}
                {run.review_cost_usd !== null && (
                  <>
                    {" · "}
                    <b>{fmtCost(run.review_cost_usd)}</b>
                  </>
                )}
              </span>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
