import { currentUserId } from "../../../../../../lib/auth";
import { deleteOzJob } from "../../../../../../lib/oz";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  try {
    const { id } = await params;
    await deleteOzJob(id, userId, { stopFirst: true, deleteRunRecords: true });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not terminate Oz job" }, { status: 400 });
  }
}
