/**
 * Decision 11 — SSE live execution stream.
 *
 * Next.js 14 App Router route handler for `/api/events`. Streams a run's
 * AgentEvents to the report UI over Server-Sent Events.
 *
 * PRODUCTION: subscribes to the runner's live event channel (e.g. Redis
 * pub/sub forwarded from the Firecracker VM) and forwards each AgentEvent as it
 * is produced, closing when the run completes.
 *
 * HERE (MVP scaffold): no live runner exists in this sandbox, so we replay the
 * recorded events from the sample run (MOCK_RUN via getRun()) as SSE frames
 * with small fixed setTimeout pacing. The pacing delay is a constant, not a
 * time/random source, and the event data itself is fully deterministic.
 */

import { getRun, MOCK_RUN } from "@kiln/shared";

/** Fixed inter-frame delay (ms) used only to simulate live pacing. */
const FRAME_DELAY_MS = 120;

export async function GET(_req: Request): Promise<Response> {
  const run = getRun(MOCK_RUN.id) ?? MOCK_RUN;
  const events = run.events;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));

      for (const event of events) {
        // One SSE message per recorded AgentEvent. JSON-encoded so the client
        // can reconstruct the typed event shape.
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        await sleep(FRAME_DELAY_MS);
      }

      // Terminal frame: signals the client that the run stream is complete.
      controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
