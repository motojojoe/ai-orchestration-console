import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
// Value import, and the only one in this file that is not a node: builtin. exit-codes.ts imports
// nothing but a type from src/lib, so this adds no cycle and nothing for the strip-types test
// loader to resolve at runtime.
import { EXIT } from "./exit-codes.ts";

/** Injectable so the failure paths are testable without a real editor. Resolves to an exit code. */
export type EditorSpawn = (program: string, args: string[]) => Promise<number>;

/** Injectable so `ask`'s loop is testable without a real TTY. Mirrors `EditorSpawn`'s shape. */
export interface AskIO {
  question(prompt: string): Promise<string>;
  close(): void;
}

/**
 * Thrown by `ask` when the input ends without answering — a piped or redirected stdin at a prompt
 * that needs a human, or Ctrl-D, which readline routes through the same `close`. Typed rather than
 * a plain `Error` so callers can tell it from a pipeline failure and map it to a usage exit code;
 * the caller owns the remedy text, because only it knows which run is parked.
 */
export class StdinNotInteractiveError extends Error {
  constructor() {
    super("stdin is not interactive — the input ended without an answer.");
    this.name = "StdinNotInteractiveError";
  }
}

/**
 * How long to hold the event loop open after re-raising SIGINT at ourselves — see `defaultAskIO`.
 * Delivery itself takes one turn of the loop, so this is really the budget for the CLI's own
 * handler to finish cancelling and exit.
 *
 * `installSignalHandler` in commands.ts sets a 30s force-exit of its own, and this timer is *not*
 * a tie with it, whatever an earlier version of this comment claimed: this one is armed
 * synchronously, immediately before `process.kill`, whereas that one is armed by the SIGINT
 * handler at least one loop turn later. Equal durations, earlier start — so at a gate this timer
 * always fires first, and a cancel still legitimately in flight at the 30s mark is cut short by
 * this message rather than by the handler's own. Both paths exit 130 either way. Bounded on
 * purpose: an unbounded hold would turn a stranded run into a hung process.
 */
const INTERRUPT_HOLD_MS = 30_000;

/**
 * Ctrl-C at a prompt, and why it needs help.
 *
 * readline's `terminal` option defaults to `output.isTTY`, and a terminal interface puts stdin in
 * **raw mode**, which clears `ISIG`. A Ctrl-C therefore arrives as the byte 0x03 to readline, not
 * as a signal to the process, so a `process.on("SIGINT")` handler — the one that cancels the run
 * and removes its worktree — never runs on its own.
 *
 * Two facts about readline drive the shape below. Both were verified under a pty on Node 22.23.1,
 * and both contradict what an earlier version of this comment claimed:
 *
 * 1. **With a `SIGINT` listener attached, readline emits `SIGINT` and leaves the pending
 *    `question` promise simply pending.** `Interface.prototype.close` never touches the question's
 *    reject; the only rejection sites are `_ttyWrite`'s `case 'c'` *else* branch — reached only
 *    when `listenerCount("SIGINT") === 0` — and `case 'd'`. So attaching this listener is also
 *    what keeps `ask` from unwinding into the caller's `finally` and tearing down the very SIGINT
 *    handler being re-raised at. No `catch` is involved, and none is needed.
 * 2. **A registered `process.on("SIGINT")` listener is not a ref'd libuv handle.**
 *    `node -e "process.on('SIGINT',()=>{})"` exits 0 immediately, and in this CLI
 *    `process.getActiveResourcesInfo()` at the prompt is `[]` — `node:sqlite` is synchronous and
 *    the event emitter is plain memory. Once `rl.close()` pauses stdin, nothing is ref'd at all,
 *    so Node ends the loop and exits **0** without ever polling for the signal we just raised.
 *    That was the shipped behavior of the previous attempt: a silent, success-coded exit leaving
 *    the row at `awaiting_approval` with a dead `owner_pid` and its worktree on disk.
 *
 * Hence: close the interface (which also takes stdin back out of raw mode, so a second Ctrl-C is a
 * real signal again and the double-Ctrl-C escape hatch still works), start one **ref'd** timer to
 * keep the loop alive long enough for the signal to be delivered and acted on, then re-raise. The
 * ordinary `installSignalHandler` path then runs unchanged, and every `ask` caller is fixed at
 * once with no cancel hook threaded through `driveToTerminal`.
 *
 * If that timer ever expires, the signal was raised but nothing exited on it. Exiting 130 with a
 * message is the honest outcome; falling through to a success code is the regression this
 * replaces.
 *
 * **End of input is the other way this prompt can end, and it needs the opposite treatment.**
 * `orch resume <id> < /dev/null`, or any wrapper that runs the CLI without a terminal, reaches a
 * gate and readline emits `close` on EOF. `Interface.prototype.close` never settles the pending
 * `question` (fact 1 above, relied on by the SIGINT path), so before this the promise stayed
 * pending, nothing was ref'd, Node ended the loop, and the process exited **0** — the same silent
 * success code over a parked run that the SIGINT work above exists to prevent, and worse here
 * because 0 is this CLI's "approved". So the pending question is rejected on `close` and the
 * caller turns that into a usage error.
 *
 * The one hazard in doing that is this file's own SIGINT path, which *also* calls `rl.close()`.
 * Rejecting there would unwind `ask` into the caller's `finally`, tearing down the very SIGINT
 * handler being re-raised at — exactly the failure fact 1 describes. Hence `interrupting`, set by
 * a listener registered *ahead* of the SIGINT handler below (EventEmitter runs listeners in
 * registration order) so it is already true by the time that handler's `rl.close()` emits `close`.
 * The SIGINT handler itself is untouched.
 *
 * `input`/`output` are parameters only so the EOF path has a unit test: `stubAskIO` in
 * prompt.test.ts cannot express end-of-input, which is why this shipped broken. Production callers
 * take the defaults and get byte-identical behavior, including readline's `terminal` inference
 * from `output.isTTY` that puts stdin in raw mode.
 */
export const defaultAskIO = (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): AskIO => {
  const rl = createInterface({ input, output });

  let interrupting = false;
  let ended = false;
  let rejectPending: ((err: Error) => void) | null = null;

  rl.once("SIGINT", () => {
    interrupting = true;
  });

  rl.once("SIGINT", () => {
    rl.close();
    setTimeout(() => {
      process.stderr.write(
        `\nInterrupted — nothing acted on it within ${INTERRUPT_HOLD_MS / 1000}s, exiting.\n` +
          "The run may still need cleaning up:  orch list\n",
      );
      process.exit(EXIT.INTERRUPTED);
    }, INTERRUPT_HOLD_MS);
    process.kill(process.pid, "SIGINT");
  });

  rl.once("close", () => {
    if (interrupting) return;
    ended = true;
    rejectPending?.(new StdinNotInteractiveError());
  });

  return {
    question: (prompt) =>
      new Promise<string>((resolve, reject) => {
        // Already at EOF before we even asked — the `close` listener has no pending question to
        // reject, so answer for it rather than handing back a promise nothing will ever settle.
        if (ended) {
          reject(new StdinNotInteractiveError());
          return;
        }
        rejectPending = reject;
        rl.question(prompt).then(
          (answer) => {
            rejectPending = null;
            resolve(answer);
          },
          (err: Error) => {
            rejectPending = null;
            reject(err);
          },
        );
      }),
    close: () => {
      // Cleared first: `ask`'s `finally` calls this on the ordinary path too, and the `close` it
      // triggers must not reject a question that already resolved.
      rejectPending = null;
      rl.close();
    },
  };
};

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
export type EditorEnv = { VISUAL?: string; EDITOR?: string; [key: string]: string | undefined };

export function resolveEditor(env: EditorEnv): { program: string; args: string[] } | null {
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
 *
 * `env` is injectable for the same reason `spawnEditor` is. Reading `process.env` directly made
 * the tests below depend on the ambient shell: run through `npm test` they passed only because
 * npm injects `EDITOR=vi` from its own `editor` config default, and run directly —
 * `node --experimental-strip-types --test src/cli/prompt.test.ts` — four of them failed on
 * "No $VISUAL or $EDITOR is set". A gate that reports green only under one launcher is not a gate.
 */
export async function editText(
  initial: string,
  spawnEditor: EditorSpawn = defaultSpawn,
  env: EditorEnv = process.env,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const editor = resolveEditor(env);
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
