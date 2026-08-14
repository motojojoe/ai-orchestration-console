import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RunStatus =
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "reviewing"
  | "approved"
  | "needs_changes"
  | "closed_needs_changes"
  | "failed"
  | "cancelled";

export type Verdict = "APPROVE" | "NEEDS_CHANGES";

export interface Run {
  id: string;
  project_path: string;
  task: string;
  status: RunStatus;
  branch_name: string;
  worktree_path: string | null;
  /**
   * PID of the process currently driving this run; null once finished. A run parked at
   * awaiting_approval or needs_changes deliberately keeps its owner_pid — approveRun/retryExecute
   * transfer it to whichever process resumes the run, rather than clearing it.
   */
  owner_pid: number | null;
  auto_approve: 0 | 1;
  plan_commit_sha: string | null;
  plan_text: string | null;
  plan_original_text: string | null;
  diff_text: string | null;
  verdict: Verdict | null;
  review_reasoning: string | null;
  retry_count: number;
  error_message: string | null;
  failed_stage: "plan" | "execute" | "review" | null;
  plan_duration_ms: number | null;
  plan_tokens_in: number | null;
  plan_tokens_out: number | null;
  plan_cost_usd: number | null;
  execute_duration_ms: number | null;
  execute_tokens_in: number | null;
  execute_tokens_out: number | null;
  execute_cost_usd: number | null;
  review_duration_ms: number | null;
  review_tokens_in: number | null;
  review_tokens_out: number | null;
  review_cost_usd: number | null;
  created_at: string;
  updated_at: string;
}

function dbPath(): string {
  const override = process.env.ORCHESTRATOR_DB_PATH;
  if (override) return override;
  return join(homedir(), ".orchestrator", "history.db");
}

/** Minimal migration helper — adds a column to an existing table if it isn't there yet. */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

let instance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (instance) return instance;

  const path = dbPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  // node:sqlite defaults busy_timeout to 0, so a second writer fails immediately with
  // SQLITE_BUSY instead of waiting. The CLI and the web app are separate processes on one file.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      worktree_path TEXT,
      owner_pid INTEGER,
      auto_approve INTEGER NOT NULL DEFAULT 1,
      plan_commit_sha TEXT,
      plan_text TEXT,
      plan_original_text TEXT,
      diff_text TEXT,
      verdict TEXT,
      review_reasoning TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      failed_stage TEXT,
      plan_duration_ms INTEGER,
      plan_tokens_in INTEGER,
      plan_tokens_out INTEGER,
      plan_cost_usd REAL,
      execute_duration_ms INTEGER,
      execute_tokens_in INTEGER,
      execute_tokens_out INTEGER,
      execute_cost_usd REAL,
      review_duration_ms INTEGER,
      review_tokens_in INTEGER,
      review_tokens_out INTEGER,
      review_cost_usd REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_projects (
      project_path TEXT PRIMARY KEY,
      last_used_at TEXT NOT NULL
    );
  `);

  addColumnIfMissing(db, "runs", "plan_commit_sha", "TEXT");
  addColumnIfMissing(db, "runs", "owner_pid", "INTEGER");

  instance = db;
  return db;
}

export function createRun(run: {
  id: string;
  project_path: string;
  task: string;
  branch_name: string;
  auto_approve: boolean;
}): Run {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs (id, project_path, task, status, branch_name, auto_approve, retry_count, created_at, updated_at)
     VALUES (@id, @project_path, @task, 'planning', @branch_name, @auto_approve, 0, @now, @now)`,
  ).run({ ...run, auto_approve: run.auto_approve ? 1 : 0, now });

  touchRecentProject(run.project_path);
  return getRun(run.id)!;
}

export function updateRun(id: string, patch: Partial<Omit<Run, "id" | "created_at">>): Run {
  const db = getDb();
  const now = new Date().toISOString();
  const fields = Object.keys(patch);
  if (fields.length === 0) return getRun(id)!;

  const setClause = fields.map((f) => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE runs SET ${setClause}, updated_at = @now WHERE id = @id`).run({
    ...patch,
    id,
    now,
  });
  return getRun(id)!;
}

export function getRun(id: string): Run | undefined {
  return getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as unknown as Run | undefined;
}

export function listRuns(limit = 50): Run[] {
  return getDb()
    .prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as unknown as Run[];
}

export function touchRecentProject(projectPath: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO recent_projects (project_path, last_used_at) VALUES (?, ?)
     ON CONFLICT(project_path) DO UPDATE SET last_used_at = excluded.last_used_at`,
  ).run(projectPath, now);
}

export function listRecentProjects(limit = 8): string[] {
  const rows = getDb()
    .prepare(`SELECT project_path FROM recent_projects ORDER BY last_used_at DESC LIMIT ?`)
    .all(limit) as unknown as { project_path: string }[];
  return rows.map((r) => r.project_path);
}

/** Statuses that mean a pipeline is mid-flight. Terminal and parked statuses are excluded. */
export const ACTIVE_STATUSES: RunStatus[] = ["planning", "executing", "reviewing"];

/**
 * Statuses where a run is parked on a *human*, not on a stage. No process work is happening, but
 * the run still owns a worktree and still expects someone to come back and answer.
 */
export const GATE_STATUSES: RunStatus[] = ["awaiting_approval", "needs_changes"];

/**
 * Every status a run can still leave — the complement of the pipeline's TERMINAL_STATUSES
 * (`approved`, `closed_needs_changes`, `failed`, `cancelled`).
 *
 * Deliberately separate from `ACTIVE_STATUSES`, which means the narrower "a stage is running" and
 * is what `cancelRun` branches on. "Is a run unfinished?" and "is a stage running?" answer
 * different questions: a run parked at a gate is not running anything, yet it still holds a
 * worktree and still means the machine is occupied. Widening `ACTIVE_STATUSES` to cover the gates
 * would silently change what `cancelRun` does.
 */
export const UNFINISHED_STATUSES: RunStatus[] = [...ACTIVE_STATUSES, ...GATE_STATUSES];

function findRunsByStatus(statuses: RunStatus[]): Run[] {
  const placeholders = statuses.map(() => "?").join(", ");
  return getDb()
    .prepare(`SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY created_at DESC`)
    .all(...statuses) as unknown as Run[];
}

/**
 * Runs that have not reached a terminal state: mid-stage *or* parked at a human gate. This is the
 * question "is this machine busy with a run?" — the one worth asking before starting another,
 * since a gate-parked run whose owner died is the most common way to strand a worktree.
 */
export function findUnfinishedRuns(): Run[] {
  return findRunsByStatus(UNFINISHED_STATUSES);
}
