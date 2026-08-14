import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "orch-db-test-"));
process.env.ORCHESTRATOR_DB_PATH = join(dir, "test.db");

// Dynamic import: ESM hoists static imports above the env assignment above.
const {
  ACTIVE_STATUSES,
  GATE_STATUSES,
  UNFINISHED_STATUSES,
  createRun,
  findUnfinishedRuns,
  getDb,
  getRun,
  updateRun,
} = await import("./db.ts");

after(() => rmSync(dir, { recursive: true, force: true }));

test("busy_timeout is set so concurrent writers wait instead of failing", () => {
  const row = getDb().prepare("PRAGMA busy_timeout").get() as { timeout: number };
  assert.equal(row.timeout, 5000);
});

test("a new run starts with no owner_pid", () => {
  const run = createRun({
    id: "run-owner",
    project_path: "/tmp/project",
    task: "t",
    branch_name: "orchestrator/run-owner",
    auto_approve: false,
  });
  assert.equal(run.owner_pid, null);
});

test("owner_pid round-trips through updateRun", () => {
  updateRun("run-owner", { owner_pid: 4242 });
  assert.equal(getRun("run-owner")!.owner_pid, 4242);
  updateRun("run-owner", { owner_pid: null });
  assert.equal(getRun("run-owner")!.owner_pid, null);
});

test("findUnfinishedRuns returns runs parked at a human gate as well as active runs", () => {
  createRun({
    id: "run-parked",
    project_path: "/tmp/project",
    task: "t",
    branch_name: "orchestrator/run-parked",
    auto_approve: false,
  });
  updateRun("run-parked", { status: "needs_changes" });
  updateRun("run-owner", { status: "executing" });

  // A run parked at a gate is exactly the case the CLI's busy-check exists for: no stage is
  // running, but the run still owns a worktree, so starting another pipeline would strand it.
  assert.deepEqual(
    findUnfinishedRuns()
      .map((r) => r.id)
      .sort(),
    ["run-owner", "run-parked"],
  );
  assert.deepEqual([...ACTIVE_STATUSES].sort(), ["executing", "planning", "reviewing"]);
});

test("findUnfinishedRuns excludes every terminal status", () => {
  for (const status of ["approved", "closed_needs_changes", "failed", "cancelled"] as const) {
    updateRun("run-parked", { status });
    assert.deepEqual(
      findUnfinishedRuns().map((r) => r.id),
      ["run-owner"],
      `${status} must not count as unfinished`,
    );
  }
  updateRun("run-parked", { status: "awaiting_approval" });
  assert.equal(findUnfinishedRuns().length, 2);
});

test("UNFINISHED_STATUSES is exactly the complement of the pipeline's terminal statuses", () => {
  // Guards against the two lists drifting apart: a status added to RunStatus and to neither list
  // would silently be treated as finished by the CLI's busy-check.
  const terminal = ["approved", "closed_needs_changes", "failed", "cancelled"];
  const all = [...UNFINISHED_STATUSES, ...terminal].sort();
  assert.deepEqual(all, [
    "approved",
    "awaiting_approval",
    "cancelled",
    "closed_needs_changes",
    "executing",
    "failed",
    "needs_changes",
    "planning",
    "reviewing",
  ]);
  assert.deepEqual([...GATE_STATUSES].sort(), ["awaiting_approval", "needs_changes"]);
});
