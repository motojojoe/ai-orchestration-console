import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderEvent } from "./render.ts";

test("a status change is announced", () => {
  assert.equal(renderEvent({ type: "status_change", status: "executing" }), "▸ executing\n");
});

test("Claude assistant text is printed as-is", () => {
  const line = renderEvent({
    type: "cli_event",
    stage: "plan",
    data: { type: "assistant", message: { content: [{ type: "text", text: "Reading db.ts" }] } },
  });
  assert.equal(line, "Reading db.ts\n");
});

test("a Claude tool call is summarised, not dumped", () => {
  const line = renderEvent({
    type: "cli_event",
    stage: "plan",
    data: { type: "assistant", message: { content: [{ type: "tool_use", name: "Grep" }] } },
  });
  assert.equal(line, "  → Grep\n");
});

test("an unrecognised event prints nothing", () => {
  const line = renderEvent({
    type: "cli_event",
    stage: "execute",
    data: { type: "some_future_event", payload: 1 },
  });
  assert.equal(line, null);
});

test("a stage failure distinguishes a timeout from an error", () => {
  assert.match(
    renderEvent({ type: "stage_failed", stage: "execute", message: "boom", timedOut: false })!,
    /execute failed: boom/,
  );
  assert.match(
    renderEvent({ type: "stage_failed", stage: "execute", message: "boom", timedOut: true })!,
    /execute timed out/,
  );
});

test("completion reports the verdict", () => {
  assert.match(renderEvent({ type: "run_completed", verdict: "APPROVE" })!, /APPROVE/);
});

test("OpenCode text events nest their text under part.text", () => {
  const line = renderEvent({
    type: "cli_event",
    stage: "execute",
    data: { type: "text", part: { text: "writing file" } },
  });
  assert.equal(line, "writing file\n");
});

test("OpenCode's step_start renders a working indicator", () => {
  const line = renderEvent({
    type: "cli_event",
    stage: "execute",
    data: { type: "step_start" },
  });
  assert.equal(line, "  → working…\n");
});
