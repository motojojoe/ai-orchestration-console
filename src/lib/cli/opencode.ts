import { type NdjsonEvent, spawnAndStreamNdjson } from "./process";

export interface OpenCodeStageResult {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

export interface RunOpenCodeOptions {
  /** The run's isolated worktree (spec §5) — Execute must never touch the user's main working directory. */
  cwd: string;
  prompt: string;
  /** OpenCode Zen free model id, e.g. "opencode/deepseek-v4-flash-free" (spec ticket 01). */
  model: string;
  onEvent: (event: NdjsonEvent) => void;
}

/**
 * OpenCode reports its own failures as a `{"type":"error",...}` NDJSON event on stdout, not on
 * stderr — stderr is empty on these failures. Prefer that event's detail; fall back to stderr
 * (or a placeholder) for exits where OpenCode crashed before it could emit anything at all.
 */
function describeOpenCodeError(events: NdjsonEvent[], stderr: string): string {
  const errorEvent = events.find((event) => event.type === "error");
  if (errorEvent) {
    const error = errorEvent.error as { name?: string; data?: { message?: string; ref?: string } } | undefined;
    const message = error?.data?.message ?? JSON.stringify(errorEvent.error ?? errorEvent);
    const ref = error?.data?.ref ? ` (ref: ${error.data.ref})` : "";
    return `${error?.name ?? "error"}: ${message}${ref}`;
  }
  return stderr.trim() || "(no error output captured)";
}

/**
 * Spec §3.2: headless OpenCode invocation for the Execute stage.
 *
 * `--dangerously-skip-permissions` is required here even though it isn't named in the spec's
 * tickets: OpenCode's default tool-permission flow expects an interactive prompt, and this
 * process has no TTY to answer one. Without it, Execute would hang until the stage timeout
 * (spec §8) killed it on every run. Scoped to the run's disposable worktree (spec §5), never
 * the user's main working directory.
 */
export function runOpenCode(opts: RunOpenCodeOptions) {
  const args = [
    "run",
    "--format",
    "json",
    "--model",
    opts.model,
    "--dir",
    opts.cwd,
    "--dangerously-skip-permissions",
  ];

  const { result, kill } = spawnAndStreamNdjson({
    command: "opencode",
    args,
    cwd: opts.cwd,
    stdinText: opts.prompt,
    onEvent: opts.onEvent,
  });

  const stagePromise = result.then(({ events, exitCode, stderr }): OpenCodeStageResult => {
    if (exitCode !== 0) {
      throw new Error(`opencode exited with code ${exitCode}: ${describeOpenCodeError(events, stderr)}`);
    }

    let text = "";
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let costUsd: number | null = null;

    for (const event of events) {
      if (event.type === "text") {
        const part = event.part as { text?: string } | undefined;
        if (part?.text) text += part.text;
      }
      if (event.type === "step_finish") {
        const part = event.part as { tokens?: { input?: number; output?: number }; cost?: number } | undefined;
        if (part?.tokens) {
          tokensIn = (tokensIn ?? 0) + (part.tokens.input ?? 0);
          tokensOut = (tokensOut ?? 0) + (part.tokens.output ?? 0);
        }
        if (typeof part?.cost === "number") {
          costUsd = (costUsd ?? 0) + part.cost;
        }
      }
    }

    return { text, tokensIn, tokensOut, costUsd };
  });

  return { result: stagePromise, kill };
}
