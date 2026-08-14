"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export default function HomePage() {
  const router = useRouter();
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  const [projectPath, setProjectPath] = useState("");
  const [task, setTask] = useState("");
  const [autoApprove, setAutoApprove] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/projects/recent")
      .then((r) => r.json())
      .then((data: { projects: string[] }) => setRecentProjects(data.projects))
      .catch(() => {
        /* recent projects are a convenience, not required to use the form */
      });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath, task, autoApprove }),
      });
      const data = (await res.json()) as { run?: { id: string }; error?: string };
      if (!res.ok || !data.run) {
        setError(data.error ?? "Something went wrong starting the run.");
        setSubmitting(false);
        return;
      }
      router.push(`/runs/${data.run.id}`);
    } catch {
      setError("Couldn't reach the console's server.");
      setSubmitting(false);
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "4rem 1.5rem" }}>
      <div style={{ marginBottom: "2.5rem" }}>
        <div className="eyebrow" style={{ marginBottom: "0.5rem" }}>
          AI Orchestration Console
        </div>
        <h1 style={{ fontSize: "1.7rem", fontWeight: 700 }}>Start a run</h1>
        <p style={{ color: "var(--ink-60)", marginTop: "0.5rem", lineHeight: 1.55 }}>
          Plan (Claude Code) → Execute (OpenCode) → Review (Claude Code), against a project on this
          machine.
        </p>
      </div>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "1.3rem" }}>
        <div>
          <label htmlFor="projectPath" className="eyebrow" style={{ display: "block", marginBottom: "0.4rem" }}>
            Project path
          </label>
          <input
            id="projectPath"
            type="text"
            className="mono"
            placeholder="/Users/you/dev/my-project"
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            style={{ width: "100%" }}
            required
          />
          {recentProjects.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.6rem" }}>
              {recentProjects.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="pill pill-pending mono"
                  onClick={() => setProjectPath(p)}
                  style={{ border: "none" }}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label htmlFor="task" className="eyebrow" style={{ display: "block", marginBottom: "0.4rem" }}>
            Task
          </label>
          <textarea
            id="task"
            placeholder="e.g. Add rate limiting to the public API"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            style={{ width: "100%", minHeight: 120, lineHeight: 1.55, resize: "vertical" }}
            required
          />
        </div>

        <label className="toggle" style={{ justifyContent: "space-between" }}>
          Auto-approve (skip straight to Execute after planning)
          <span className="switch">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
              aria-label="Auto-approve future runs"
            />
            <span className="track" />
            <span className="thumb" />
          </span>
        </label>

        {error && (
          <div
            role="alert"
            style={{
              background: "var(--bad-wash)",
              color: "var(--bad)",
              borderRadius: 8,
              padding: "0.7em 1em",
              fontSize: "0.9rem",
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", gap: "1rem", fontSize: "0.86rem" }}>
            <a href="/runs" style={{ color: "var(--ink-60)" }}>
              View run history →
            </a>
            <a href="/docs" style={{ color: "var(--ink-60)" }}>
              Docs →
            </a>
          </div>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Starting…" : "Start run"}
          </button>
        </div>
      </form>
    </main>
  );
}
