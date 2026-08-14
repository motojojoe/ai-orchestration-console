import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import {
  StdinNotInteractiveError,
  ask,
  defaultAskIO,
  editText,
  resolveEditor,
  type AskIO,
} from "./prompt.ts";

/** Feeds canned answers to `ask` without a real TTY. Never runs out — repeats the last answer. */
function stubAskIO(answers: string[]): AskIO {
  let i = 0;
  return {
    question: async () => answers[Math.min(i++, answers.length - 1)] ?? "",
    close: () => {},
  };
}

/**
 * The one thing `stubAskIO` cannot express: input that *ends*. Its `question` repeats the last
 * answer forever, so every test written against it exercises a stream that never runs out — which
 * is exactly why a piped stdin at a gate shipped exiting 0. This double runs out.
 */
function eofAskIO(answers: string[]): AskIO & { closed: boolean } {
  let i = 0;
  const io = {
    closed: false,
    question: async () => {
      if (i >= answers.length) throw new StdinNotInteractiveError();
      return answers[i++]!;
    },
    close: () => {
      io.closed = true;
    },
  };
  return io;
}

/** Fails the test rather than hanging it: a pending-forever `ask` is the bug under test. */
function withinHalfASecond<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("ask never settled")), 500)),
  ]);
}

const sink = (): Writable => new Writable({ write: (_c, _e, cb) => cb() });

test("ask matches case-insensitively and returns the choice as given, not the user's raw casing", async () => {
  const result = await ask("Continue?", ["Y", "n"], stubAskIO(["y"]));
  assert.equal(result, "Y");
});

test("ask does not loop forever when choices aren't lowercase — the original bug", async () => {
  // Regression: comparing a lowercased answer against the raw (unnormalized) choices array meant
  // ["Y", "n"] could never match a lowercase reply, so the prompt would re-ask forever. A second
  // canned answer proves the loop can still terminate at all once the first is accepted.
  const io = stubAskIO(["y"]);
  const result = await Promise.race([
    ask("Continue?", ["Y", "n"], io),
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error("ask never resolved")), 500)),
  ]);
  assert.equal(result, "Y");
});

test("ask reprompts on an unrecognised answer, then accepts a later valid one", async () => {
  const result = await ask("Continue?", ["Y", "n"], stubAskIO(["nope", "N"]));
  assert.equal(result, "n");
});

test("ask surfaces end-of-input instead of hanging or resolving", async () => {
  // The C1 regression: a gate reached with a non-interactive stdin used to leave the question
  // pending forever, so nothing was ref'd, Node ended the loop, and `orch` exited 0 — this CLI's
  // own code for "approved" — over a run still parked with its worktree on disk.
  const io = eofAskIO([]);
  await assert.rejects(() => withinHalfASecond(ask("Approve?", ["a", "r"], io)), StdinNotInteractiveError);
  assert.equal(io.closed, true, "ask must still close its io when the input ends");
});

test("ask surfaces end-of-input reached part way through re-prompting", async () => {
  const io = eofAskIO(["nope"]);
  await assert.rejects(() => withinHalfASecond(ask("Approve?", ["a", "r"], io)), StdinNotInteractiveError);
});

test("defaultAskIO rejects when its input stream ends without an answer", async () => {
  // Against the real readline wiring, not a double: `close` on EOF is the event the fix hangs on.
  const input = new PassThrough();
  const pending = withinHalfASecond(ask("Approve?", ["a", "r"], defaultAskIO(input, sink())));
  input.end();
  await assert.rejects(() => pending, StdinNotInteractiveError);
});

test("defaultAskIO still answers normally from a stream that has input", async () => {
  const input = new PassThrough();
  const pending = withinHalfASecond(ask("Approve?", ["a", "r"], defaultAskIO(input, sink())));
  input.write("a\n");
  assert.equal(await pending, "a");
});

test("defaultAskIO rejects an input stream that had already ended", async () => {
  const input = new PassThrough();
  input.end();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => withinHalfASecond(ask("Approve?", ["a", "r"], defaultAskIO(input, sink()))),
    StdinNotInteractiveError,
  );
});

test("VISUAL wins over EDITOR, and arguments are split off", () => {
  assert.deepEqual(resolveEditor({ VISUAL: "code --wait", EDITOR: "vi" }), {
    program: "code",
    args: ["--wait"],
  });
});

test("EDITOR is used when VISUAL is unset", () => {
  assert.deepEqual(resolveEditor({ EDITOR: "nano" }), { program: "nano", args: [] });
});

test("no editor configured is null — never guess vi", () => {
  assert.equal(resolveEditor({}), null);
  assert.equal(resolveEditor({ EDITOR: "  " }), null);
});

test("a saved edit is returned and the temp file is cleaned up", async () => {
  let seen = "";
  const result = await editText(
    "original plan",
    async (_program, args) => {
      seen = args[args.length - 1]!;
      assert.equal(readFileSync(seen, "utf-8"), "original plan");
      writeFileSync(seen, "edited plan");
      return 0;
    },
    { EDITOR: "stub-editor" },
  );
  assert.deepEqual(result, { ok: true, text: "edited plan" });
  assert.throws(() => readFileSync(seen, "utf-8"), /ENOENT/);
});

test("a non-zero editor exit keeps the original", async () => {
  const result = await editText(
    "original plan",
    async (_p, args) => {
      writeFileSync(args[args.length - 1]!, "half-written");
      return 1;
    },
    { EDITOR: "stub-editor" },
  );
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /exited with 1/);
});

test("an editor that cannot spawn is reported, not thrown", async () => {
  const result = await editText(
    "original plan",
    async () => {
      throw new Error("spawn ENOENT");
    },
    { EDITOR: "stub-editor" },
  );
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /spawn ENOENT/);
});

test("an emptied file is refused, matching the web console's fallback", async () => {
  const result = await editText(
    "original plan",
    async (_p, args) => {
      writeFileSync(args[args.length - 1]!, "   \n  ");
      return 0;
    },
    { EDITOR: "stub-editor" },
  );
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /empty/i);
});

test("with no editor configured, editText refuses before spawning anything", async () => {
  let spawned = false;
  const result = await editText(
    "original plan",
    async () => {
      spawned = true;
      return 0;
    },
    {},
  );
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /\$EDITOR/);
  assert.equal(spawned, false, "must refuse before spawning anything");
});
