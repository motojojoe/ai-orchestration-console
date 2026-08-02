import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PreflightResult = { ok: true } | { ok: false; reason: string };

/**
 * Spec §9: no credential store of our own — check whatever auth each CLI already has configured
 * on the machine. Uses each CLI's own lightweight status command, not a live generation call.
 */
export async function checkClaudeAuth(): Promise<PreflightResult> {
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status"]);
    const parsed = JSON.parse(stdout) as { loggedIn?: boolean };
    if (!parsed.loggedIn) {
      return { ok: false, reason: "Claude Code isn't authenticated — run `claude auth login`." };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "Couldn't check Claude Code auth status — run `claude auth login`." };
  }
}

export async function checkOpenCodeAuth(): Promise<PreflightResult> {
  try {
    const { stdout } = await execFileAsync("opencode", ["auth", "list"]);
    // eslint-disable-next-line no-control-regex
    const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
    const match = plain.match(/(\d+)\s+credentials?/);
    const count = match ? Number(match[1]) : 0;
    if (count < 1) {
      return { ok: false, reason: "OpenCode isn't authenticated — run `opencode auth login`." };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "Couldn't check OpenCode auth status — run `opencode auth login`." };
  }
}

export async function checkCredentials(): Promise<PreflightResult> {
  const [claude, opencode] = await Promise.all([checkClaudeAuth(), checkOpenCodeAuth()]);
  if (!claude.ok) return claude;
  if (!opencode.ok) return opencode;
  return { ok: true };
}
