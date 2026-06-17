import { currentUserId } from "../../../../../../lib/auth";
import { approveOzJob } from "../../../../../../lib/oz";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  try {
    const { id } = await params;
    return Response.json({ job: await approveOzJob(id, userId) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not approve suite" }, { status: 400 });
  }
}
