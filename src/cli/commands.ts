import { getRun, listRuns, type Run } from "../lib/db";
import { checkCredentials } from "../lib/preflight";
import { EXIT } from "./exit-codes";

function fmtCost(n: number | null): string {
  return n === null ? "—" : `$${n.toFixed(4)}`;
}

function fmtDuration(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

export async function list(): Promise<number> {
  const runs = listRuns(20);
  if (runs.length === 0) {
    process.stdout.write("No runs yet.\n");
    return EXIT.OK;
  }
  for (const run of runs) {
    const task = run.task.length > 48 ? `${run.task.slice(0, 47)}…` : run.task;
    process.stdout.write(
      `${run.id.slice(0, 8)}  ${run.status.padEnd(20)}  ${run.created_at.slice(0, 16)}  ${task}\n`,
    );
  }
  return EXIT.OK;
}

export async function show(id: string): Promise<number> {
  const run = getRun(id);
  if (!run) {
    process.stderr.write(`Run not found: ${id}\n`);
    return EXIT.USAGE;
  }
  const lines: [string, string][] = [
    ["id", run.id],
    ["task", run.task],
    ["project", run.project_path],
    ["status", run.status],
    ["branch", run.branch_name],
    ["verdict", run.verdict ?? "—"],
    ["retries", String(run.retry_count)],
    ["plan", `${fmtDuration(run.plan_duration_ms)}  ${fmtCost(run.plan_cost_usd)}`],
    ["execute", `${fmtDuration(run.execute_duration_ms)}  ${fmtCost(run.execute_cost_usd)}`],
    ["review", `${fmtDuration(run.review_duration_ms)}  ${fmtCost(run.review_cost_usd)}`],
  ];
  for (const [label, value] of lines) {
    process.stdout.write(`${label.padEnd(9)} ${value}\n`);
  }
  if (run.error_message) {
    process.stdout.write(`\nerror (${run.failed_stage ?? "?"}): ${run.error_message}\n`);
  }
  if (run.review_reasoning) {
    process.stdout.write(`\n${run.review_reasoning}\n`);
  }
  return EXIT.OK;
}

export async function doctor(): Promise<number> {
  const result = await checkCredentials();
  if (!result.ok) {
    process.stderr.write(`✗ ${result.reason}\n`);
    return EXIT.USAGE;
  }
  process.stdout.write("✓ claude and opencode are both authenticated\n");
  return EXIT.OK;
}
