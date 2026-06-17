import { getStore } from "@kiln/shared/store";
import { currentUserId } from "../../../../../../lib/auth";
import { refreshOwnedOzJob } from "../../../../../../lib/oz";

export const runtime = "nodejs";

const TERMINAL = new Set(["awaiting_approval", "blocked", "failed", "complete"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return new Response("GitHub sign-in required", { status: 401 });
  const { id } = await params;
  const url = new URL(req.url);
  let cursor = url.searchParams.get("after") ?? undefined;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < 240; i += 1) {
        if (req.signal.aborted) break;
        try {
          const job = await refreshOwnedOzJob(id, userId);
          const artifacts = await getStore().listOzArtifacts(id);
          const events = await getStore().listOzEvents(id, { afterId: cursor, limit: 100 });
          cursor = events.at(-1)?.id ?? cursor;
          controller.enqueue(encoder.encode(`event: oz\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ job, artifacts, events, cursor })}\n\n`));
          if (TERMINAL.has(job.status)) break;
        } catch {
          controller.enqueue(encoder.encode(`event: error\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "Oz job not found" })}\n\n`));
          break;
        }
        await sleep(1_500);
      }
      controller.close();
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
