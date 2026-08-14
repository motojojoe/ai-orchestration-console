import type { NdjsonEvent } from "../lib/cli/process";
import type { RunEvent } from "../lib/orchestrator/events";

/** Claude's stream-json shape, as much of it as we read. Mirrors RunView.tsx's formatCliEvent. */
interface ClaudeContentBlock {
  type: string;
  text?: string;
  name?: string;
}

function renderClaudeEvent(data: NdjsonEvent): string | null {
  if (data.type !== "assistant") return null;
  const message = data.message as { content?: ClaudeContentBlock[] } | undefined;
  const content = message?.content ?? [];

  const text = content.find((c) => c.type === "text")?.text;
  if (text) return `${text}\n`;
  if (content.some((c) => c.type === "thinking")) return "  … thinking\n";

  const tool = content.find((c) => c.type === "tool_use");
  if (tool?.name) return `  → ${tool.name}\n`;
  return null;
}

// OpenCode's "text" event nests the streamed text under `part.text`, not a top-level `text`
// field — confirmed against RunView.tsx's formatCliEvent (the shape actually run against the
// real CLI), not the flat shape a first draft of this module assumed.
function renderOpenCodeEvent(data: NdjsonEvent): string | null {
  if (data.type === "step_start") return "  → working…\n";
  if (data.type === "text") {
    const part = data.part as { text?: string } | undefined;
    return part?.text ? `${part.text}\n` : null;
  }
  return null;
}

/** `null` means print nothing — an unrecognised event is quieter than a JSON dump. */
export function renderEvent(event: RunEvent): string | null {
  switch (event.type) {
    case "status_change":
      return `▸ ${event.status}\n`;
    case "cli_event":
      return event.stage === "execute"
        ? renderOpenCodeEvent(event.data)
        : renderClaudeEvent(event.data);
    case "stage_failed":
      return event.timedOut
        ? `✗ ${event.stage} timed out: ${event.message}\n`
        : `✗ ${event.stage} failed: ${event.message}\n`;
    case "run_completed":
      return `▪ review verdict: ${event.verdict}\n`;
  }
}
