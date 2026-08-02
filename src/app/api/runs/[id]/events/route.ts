import { getRun } from "@/lib/db";
import { subscribeRunEvents } from "@/lib/orchestrator/events";

export const dynamic = "force-dynamic";

/** Spec §2: SSE — one-directional stream of stage events; actions go over plain HTTP routes. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getRun(id)) {
    return new Response("Run not found", { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      send({ type: "connected" });
      const unsubscribe = subscribeRunEvents(id, send);

      // Keep intermediaries (proxies, browsers) from timing out an idle connection.
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15000);

      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      _req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
