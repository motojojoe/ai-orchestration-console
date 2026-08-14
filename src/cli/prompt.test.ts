import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { ask, editText, resolveEditor, type AskIO } from "./prompt.ts";

/** Feeds canned answers to `ask` without a real TTY. Never runs out — repeats the last answer. */
function stubAskIO(answers: string[]): AskIO {
  let i = 0;
  return {
    question: async () => answers[Math.min(i++, answers.length - 1)] ?? "",
    close: () => {},
  };
}

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
