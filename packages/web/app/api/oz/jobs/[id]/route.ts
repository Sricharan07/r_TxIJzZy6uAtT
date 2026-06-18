import { getStore } from "@kiln/shared/store";
import { currentUserId } from "../../../../../lib/auth";
import { deleteOzJob, refreshOwnedOzJob } from "../../../../../lib/oz";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  try {
    const { id } = await params;
    const job = await refreshOwnedOzJob(id, userId);
    const store = getStore();
    const [artifacts, secrets] = await Promise.all([
      store.listOzArtifacts(id),
      store.listProductSecretSummaries(userId, "oz_job", id),
    ]);
    return Response.json({ job, artifacts, secrets });
  } catch {
    return Response.json({ error: "Oz job not found" }, { status: 404 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  try {
    const { id } = await params;
    await deleteOzJob(id, userId, { stopFirst: true, deleteRunRecords: true });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not delete Oz job" }, { status: 404 });
  }
}
