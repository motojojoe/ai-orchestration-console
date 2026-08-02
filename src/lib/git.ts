import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 * 64 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")} failed: ${e.stderr || e.message}`);
  }
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** Spec §10: path exists + is a directory, is a git repo, working tree is clean. */
export async function validateProject(projectPath: string): Promise<ValidationResult> {
  if (!existsSync(projectPath)) {
    return { ok: false, reason: `Path does not exist: ${projectPath}` };
  }
  if (!statSync(projectPath).isDirectory()) {
    return { ok: false, reason: `Path is not a directory: ${projectPath}` };
  }

  try {
    const { stdout } = await runGit(["rev-parse", "--is-inside-work-tree"], projectPath);
    if (stdout.trim() !== "true") {
      return { ok: false, reason: `Not a git repository: ${projectPath}` };
    }
  } catch {
    return { ok: false, reason: `Not a git repository: ${projectPath}` };
  }

  const { stdout: status } = await runGit(["status", "--porcelain"], projectPath);
  if (status.trim().length > 0) {
    return {
      ok: false,
      reason: "Uncommitted changes in this repo — commit or stash them before starting a run.",
    };
  }

  return { ok: true };
}

export interface RunWorktree {
  branchName: string;
  worktreePath: string;
}

/** Spec §5: dedicated git worktree per run, branch `orchestrator/<run-id>`. */
export async function createRunWorktree(projectPath: string, runId: string): Promise<RunWorktree> {
  const branchName = `orchestrator/${runId}`;
  const worktreePath = join(projectPath, ".orchestrator-worktrees", `run-${runId}`);
  const parent = dirname(worktreePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });

  await runGit(["worktree", "add", "-b", branchName, worktreePath], projectPath);
  return { branchName, worktreePath };
}

/** Spec §5: worktree directory is removed on any terminal state; the branch is never deleted. */
export async function removeRunWorktree(projectPath: string, worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) return;
  await runGit(["worktree", "remove", "--force", worktreePath], projectPath);
}

/** Spec §4: plan file is committed as the first commit on the run's branch. */
export async function writePlanFileAndCommit(worktreePath: string, planText: string): Promise<void> {
  const orchestratorDir = join(worktreePath, ".orchestrator");
  if (!existsSync(orchestratorDir)) mkdirSync(orchestratorDir, { recursive: true });
  writeFileSync(join(orchestratorDir, "plan.md"), planText, "utf-8");

  await runGit(["add", ".orchestrator/plan.md"], worktreePath);
  await runGit(["commit", "-m", "orchestrator: add plan"], worktreePath);
}

/** Spec §3.2: OpenCode reports no aggregate diff, so we compute it ourselves. */
export async function computeDiff(worktreePath: string): Promise<string> {
  const { stdout } = await runGit(["diff", "HEAD"], worktreePath);
  return stdout;
}
