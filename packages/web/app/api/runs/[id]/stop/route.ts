import { getStore } from "@kiln/shared/store";
import { currentUserId } from "../../../../../lib/auth";
import { stopOzJob } from "../../../../../lib/oz";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  const { id } = await params;
  const store = getStore();
  const run = await store.getRun(id);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  const evalRecord = await store.getEval(run.evalId);
  if (!evalRecord || evalRecord.userId !== userId) return Response.json({ error: "Run not found" }, { status: 404 });

  const ozJob = (await store.listOzJobs(userId)).find((job) => job.state.run?.runIds.includes(id));
  if (ozJob) {
    return Response.json({ job: await stopOzJob(ozJob.id, userId) });
  }

  await store.stopRuns([id], "Stopped by user before completion.");
  return Response.json({ ok: true });
}
