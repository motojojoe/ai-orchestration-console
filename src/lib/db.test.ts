import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "orch-db-test-"));
process.env.ORCHESTRATOR_DB_PATH = join(dir, "test.db");

// Dynamic import: ESM hoists static imports above the env assignment above.
const { ACTIVE_STATUSES, createRun, findActiveRuns, getDb, getRun, updateRun } =
  await import("./db.ts");

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

test("findActiveRuns returns only runs in an active status", () => {
  createRun({
    id: "run-parked",
    project_path: "/tmp/project",
    task: "t",
    branch_name: "orchestrator/run-parked",
    auto_approve: false,
  });
  updateRun("run-parked", { status: "needs_changes" });
  updateRun("run-owner", { status: "executing" });

  const active = findActiveRuns();
  assert.deepEqual(active.map((r) => r.id), ["run-owner"]);
  assert.deepEqual([...ACTIVE_STATUSES].sort(), ["executing", "planning", "reviewing"]);
});
