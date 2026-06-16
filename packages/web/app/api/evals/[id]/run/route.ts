import { getStore } from "@kiln/shared/store";
import { createRunsForEval, enqueueRun } from "../../../../../lib/jobs";
import { currentUserId } from "../../../../../lib/auth";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const store = getStore();
  const { id } = await params;
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  const evalRecord = await store.getEval(id);
  if (!evalRecord) {
    return Response.json({ error: "Eval not found" }, { status: 404 });
  }
  if (evalRecord.userId !== userId) {
    return Response.json({ error: "Only the eval owner can re-run this config directly" }, { status: 403 });
  }
  const runs = await createRunsForEval(store, evalRecord);
  try {
    await Promise.all(runs.map((run) => enqueueRun(evalRecord, run)));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Could not enqueue run" },
      { status: 503 },
    );
  }
  const firstRun = runs[0]!;
  return Response.json({
    runId: firstRun.id,
    runIds: runs.map((run) => run.id),
    reportUrl: `/reports/${firstRun.id}`,
    status: firstRun.status,
  });
}
