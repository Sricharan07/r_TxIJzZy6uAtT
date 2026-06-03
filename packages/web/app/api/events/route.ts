import { getStore } from "@kiln/shared/store";

export const runtime = "nodejs";

const POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId");
  if (!runId) {
    return Response.json({ error: "runId is required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sent = 0;
      for (;;) {
        const run = await getStore().getRun(runId);
        if (!run) {
          controller.enqueue(encoder.encode(`event: error\ndata: {"message":"Run not found"}\n\n`));
          controller.close();
          return;
        }

        for (const event of run.events.slice(sent)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        sent = run.events.length;

        if (run.status === "completed" || run.status === "errored") {
          controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
          controller.close();
          return;
        }

        await sleep(POLL_MS);
      }
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
