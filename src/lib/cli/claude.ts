import { type NdjsonEvent, spawnAndStreamNdjson } from "./process";

export interface ClaudeStageResult {
  resultText: string;
  isError: boolean;
  costUsd: number | null;
  durationMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

interface ClaudeResultEvent {
  type: "result";
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface RunClaudeOptions {
  /** The run's worktree — Claude explores/reads relative to this directory. */
  cwd: string;
  prompt: string;
  /** Spec §3.1: Plan runs in `--permission-mode plan` (no file access at all). Spec §3.3: Review is read-only via an allowlist. */
  mode: "plan" | "review";
  onEvent: (event: NdjsonEvent) => void;
}

/**
 * Spec §3.1 / §3.3: headless Claude Code invocation for the Plan and Review stages.
 * Always a fresh session — Review never resumes Plan's session (ticket 03).
 */
export function runClaude(opts: RunClaudeOptions) {
  const args = ["--print", "--output-format", "stream-json", "--verbose"];
  if (opts.mode === "plan") {
    args.push("--permission-mode", "plan");
  } else {
    args.push("--allowedTools", "Read Grep Glob");
  }

  const { result, kill } = spawnAndStreamNdjson({
    command: "claude",
    args,
    cwd: opts.cwd,
    stdinText: opts.prompt,
    onEvent: opts.onEvent,
  });

  const stagePromise = result.then(({ events, exitCode, stderr }): ClaudeStageResult => {
    const resultEvent = events.find((e) => e.type === "result") as ClaudeResultEvent | undefined;
    if (!resultEvent) {
      throw new Error(
        `claude (${opts.mode}) exited with code ${exitCode} and no result event: ${stderr.slice(0, 4000)}`,
      );
    }
    return {
      resultText: resultEvent.result ?? "",
      isError: Boolean(resultEvent.is_error),
      costUsd: resultEvent.total_cost_usd ?? null,
      durationMs: resultEvent.duration_ms ?? null,
      tokensIn: resultEvent.usage?.input_tokens ?? null,
      tokensOut: resultEvent.usage?.output_tokens ?? null,
    };
  });

  return { result: stagePromise, kill };
}

/** Spec §3.3: Review must open its reply with a parseable verdict line. */
export function parseVerdict(resultText: string): { verdict: "APPROVE" | "NEEDS_CHANGES"; reasoning: string } {
  const match = resultText.match(/^\s*VERDICT:\s*(APPROVE|NEEDS_CHANGES)\s*\n?([\s\S]*)$/);
  if (!match) {
    // Defensive default — treat an unparseable reply as needing a human look, never a silent pass.
    return { verdict: "NEEDS_CHANGES", reasoning: `Review reply had no parseable VERDICT line:\n\n${resultText}` };
  }
  return { verdict: match[1] as "APPROVE" | "NEEDS_CHANGES", reasoning: (match[2] ?? "").trim() };
}
