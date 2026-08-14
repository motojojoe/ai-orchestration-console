import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { editText, resolveEditor } from "./prompt.ts";

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
  const result = await editText("original plan", async (_program, args) => {
    seen = args[args.length - 1]!;
    assert.equal(readFileSync(seen, "utf-8"), "original plan");
    writeFileSync(seen, "edited plan");
    return 0;
  });
  assert.deepEqual(result, { ok: true, text: "edited plan" });
  assert.throws(() => readFileSync(seen, "utf-8"), /ENOENT/);
});

test("a non-zero editor exit keeps the original", async () => {
  const result = await editText("original plan", async (_p, args) => {
    writeFileSync(args[args.length - 1]!, "half-written");
    return 1;
  });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /exited with 1/);
});

test("an editor that cannot spawn is reported, not thrown", async () => {
  const result = await editText("original plan", async () => {
    throw new Error("spawn ENOENT");
  });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /spawn ENOENT/);
});

test("an emptied file is refused, matching the web console's fallback", async () => {
  const result = await editText("original plan", async (_p, args) => {
    writeFileSync(args[args.length - 1]!, "   \n  ");
    return 0;
  });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /empty/i);
});

test("with no editor configured, editText refuses before spawning anything", async () => {
  const saved = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };
  delete process.env.VISUAL;
  delete process.env.EDITOR;
  try {
    const result = await editText("original plan");
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /\$EDITOR/);
  } finally {
    if (saved.VISUAL !== undefined) process.env.VISUAL = saved.VISUAL;
    if (saved.EDITOR !== undefined) process.env.EDITOR = saved.EDITOR;
  }
});
