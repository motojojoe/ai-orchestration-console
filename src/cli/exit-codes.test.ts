import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EXIT, exitCodeForStatus } from "./exit-codes.ts";

test("an approved run exits 0", () => {
  assert.equal(exitCodeForStatus("approved"), EXIT.OK);
  assert.equal(EXIT.OK, 0);
});

test("finishing without approval exits 1", () => {
  assert.equal(exitCodeForStatus("closed_needs_changes"), 1);
});

test("a failed stage exits 2, a cancelled run exits 130", () => {
  assert.equal(exitCodeForStatus("failed"), 2);
  assert.equal(exitCodeForStatus("cancelled"), 130);
});

test("needs_changes has no exit code — the run flow must resolve it first", () => {
  assert.throws(() => exitCodeForStatus("needs_changes"), /not a terminal status/);
});

test("a mid-flight status has no exit code", () => {
  assert.throws(() => exitCodeForStatus("executing"), /not a terminal status/);
});
