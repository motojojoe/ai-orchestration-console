import { strict as assert } from "node:assert";
import { test } from "node:test";
import { clearController, hasLiveStage, isPidAlive, runStage } from "./control.ts";

test("hasLiveStage is false for an unknown run", () => {
  assert.equal(hasLiveStage("never-seen"), false);
});

test("hasLiveStage is true only while a stage is in flight", async () => {
  let settle: (v: string) => void;
  const result = new Promise<string>((r) => { settle = r; });
  const stage = runStage("run-live", { result, kill: () => {} });

  assert.equal(hasLiveStage("run-live"), true);
  settle!("done");
  await stage;
  assert.equal(hasLiveStage("run-live"), false);

  clearController("run-live");
});

test("isPidAlive recognises this process and rejects a null pid", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(null), false);
});

test("isPidAlive is false for a pid that cannot exist", () => {
  assert.equal(isPidAlive(0x7fffffff), false);
});
