import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

/** Injectable so the failure paths are testable without a real editor. Resolves to an exit code. */
export type EditorSpawn = (program: string, args: string[]) => Promise<number>;

/** Injectable so `ask`'s loop is testable without a real TTY. Mirrors `EditorSpawn`'s shape. */
export interface AskIO {
  question(prompt: string): Promise<string>;
  close(): void;
}

const defaultAskIO = (): AskIO => createInterface({ input: process.stdin, output: process.stdout });

/**
 * Asks until one of `choices` is entered. Comparison is case-insensitive, and the value returned
 * is the matching entry from `choices` itself — never the user's raw casing. That matters:
 * comparing a lowercased answer against the raw `choices` array (the original bug here) means a
 * caller passing anything but all-lowercase choices, e.g. `["Y", "n"]`, can never match — the
 * loop re-prompts forever, naming the exact input it just rejected, with no way out but Ctrl-C.
 */
export async function ask(
  question: string,
  choices: string[],
  io: AskIO = defaultAskIO(),
): Promise<string> {
  try {
    for (;;) {
      const answer = (await io.question(`${question} [${choices.join("/")}] `)).trim().toLowerCase();
      const match = choices.find((c) => c.toLowerCase() === answer);
      if (match) return match;
      process.stdout.write(`Please answer one of: ${choices.join(", ")}\n`);
    }
  } finally {
    io.close();
  }
}

/**
 * `$VISUAL` first, then `$EDITOR`. Never falls back to a guess — a wrong guess drops the user into
 * an editor they may not know how to leave. The value is split on whitespace so `code --wait`
 * works; nothing goes through a shell, which keeps quoting and injection out of it.
 *
 * Typed as a minimal structural subset of `NodeJS.ProcessEnv` rather than the full interface:
 * Next.js's ambient `next/types/global.d.ts` augments `NodeJS.ProcessEnv` to require a readonly
 * `NODE_ENV`, which real `process.env` always has but a test's plain `{ EDITOR: "nano" }` literal
 * does not. `process.env` itself still satisfies this narrower type structurally. The index
 * signature keeps this from being a "weak type" (all-optional-properties) in TS's eyes, which
 * would otherwise reject `process.env` for sharing no *declared* property name with it — VISUAL
 * and EDITOR reach `process.env` only through its own index signature, not as named properties.
 */
export function resolveEditor(
  env: { VISUAL?: string; EDITOR?: string; [key: string]: string | undefined },
): { program: string; args: string[] } | null {
  const raw = (env.VISUAL ?? env.EDITOR ?? "").trim();
  if (!raw) return null;
  const [program, ...args] = raw.split(/\s+/);
  return program ? { program, args } : null;
}

const defaultSpawn: EditorSpawn = (program, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

/**
 * Round-trips text through the user's editor. Any failure keeps the original: approveRun commits
 * whatever string it is handed, and the web route falls back to the stored plan when the submitted
 * one is empty, so refusing empty text here is what keeps the two interfaces in agreement.
 */
export async function editText(
  initial: string,
  spawnEditor: EditorSpawn = defaultSpawn,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const editor = resolveEditor(process.env);
  if (!editor) {
    return { ok: false, reason: "No $VISUAL or $EDITOR is set — set one and try again." };
  }

  const dir = mkdtempSync(join(tmpdir(), "orch-plan-"));
  const file = join(dir, "plan.md");
  try {
    writeFileSync(file, initial, { encoding: "utf-8", mode: 0o600 });

    let code: number;
    try {
      code = await spawnEditor(editor.program, [...editor.args, file]);
    } catch (err) {
      return { ok: false, reason: `Could not start ${editor.program}: ${(err as Error).message}` };
    }
    if (code !== 0) {
      return { ok: false, reason: `${editor.program} exited with ${code} — plan left unchanged.` };
    }

    const text = readFileSync(file, "utf-8");
    if (!text.trim()) {
      return { ok: false, reason: "The plan came back empty — plan left unchanged." };
    }
    return { ok: true, text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
