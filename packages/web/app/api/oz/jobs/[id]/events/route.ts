import { getStore } from "@kiln/shared/store";
import { currentUserId } from "../../../../../../lib/auth";
import { requireOwnedOzJob } from "../../../../../../lib/oz";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  const { id } = await params;
  try {
    await requireOwnedOzJob(id, userId);
    const events = await getStore().listOzEvents(id);
    return Response.json({ events });
  } catch {
    return Response.json({ error: "Oz job not found" }, { status: 404 });
  }
}
