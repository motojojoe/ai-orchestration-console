import { spawn } from "node:child_process";

export type NdjsonEvent = Record<string, unknown>;

export interface SpawnStreamOptions {
  command: string;
  args: string[];
  cwd: string;
  stdinText?: string;
  onEvent: (event: NdjsonEvent) => void;
}

export interface SpawnStreamResult {
  exitCode: number | null;
  events: NdjsonEvent[];
  stderr: string;
}

export interface SpawnStreamHandle {
  result: Promise<SpawnStreamResult>;
  /** Spec §6 error handling: SIGTERM first, caller escalates to SIGKILL after a grace period. */
  kill: (signal: NodeJS.Signals) => void;
}

/** Spawns a CLI, feeds it stdinText, and parses its stdout as newline-delimited JSON. */
export function spawnAndStreamNdjson(opts: SpawnStreamOptions): SpawnStreamHandle {
  const child = spawn(opts.command, opts.args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });

  const events: NdjsonEvent[] = [];
  let buffer = "";
  let stderr = "";

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line) as NdjsonEvent;
      events.push(parsed);
      opts.onEvent(parsed);
    } catch {
      // Non-JSON stdout line (shouldn't happen with --format/--output-format json*); ignore.
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      consumeLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });

  if (opts.stdinText !== undefined) {
    child.stdin.write(opts.stdinText, "utf-8");
  }
  child.stdin.end();

  const result = new Promise<SpawnStreamResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer.trim()) consumeLine(buffer);
      resolve({ exitCode: code, events, stderr });
    });
  });

  const kill = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };

  return { result, kill };
}
