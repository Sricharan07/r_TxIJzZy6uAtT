import { getStore } from "@kiln/shared/store";
import { currentUserId } from "../../../../../../lib/auth";
import { refreshOwnedOzJob } from "../../../../../../lib/oz";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  const { id } = await params;
  try {
    await refreshOwnedOzJob(id, userId);
    const url = new URL(req.url);
    const afterId = url.searchParams.get("after") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? 250);
    const events = await getStore().listOzEvents(id, { afterId, limit });
    return Response.json({ events, cursor: events.at(-1)?.id ?? afterId ?? null });
  } catch {
    return Response.json({ error: "Oz job not found" }, { status: 404 });
  }
}
