import Link from "next/link";
import { listRuns, type RunStatus } from "@/lib/db";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<RunStatus, { label: string; cls: string }> = {
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

export default function RunsHistoryPage() {
  const runs = listRuns();

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "3rem 1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "2rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>Run history</h1>
        <Link href="/" className="btn btn-primary">
          New run
        </Link>
      </div>

      {runs.length === 0 ? (
        <p style={{ color: "var(--ink-60)" }}>No runs yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {runs.map((run) => (
            <Link
              key={run.id}
              href={`/runs/${run.id}`}
              className="card"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", textDecoration: "none" }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: "var(--ink)" }}>{run.task}</span>
                <span className="mono" style={{ fontSize: "0.78rem", color: "var(--ink-60)" }}>
                  {run.project_path} · {run.branch_name} · {new Date(run.created_at).toLocaleString()}
                </span>
              </div>
              <span className={`pill ${STATUS_LABEL[run.status].cls}`} style={{ flex: "none" }}>
                {STATUS_LABEL[run.status].label}
              </span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
