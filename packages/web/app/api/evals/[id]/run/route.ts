import { getStore } from "@kiln/shared/store";
import { enqueueRun } from "../../../../../lib/jobs";
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
  const run = await store.createRun(evalRecord);
  enqueueRun(evalRecord, run);
  return Response.json({ runId: run.id, reportUrl: `/reports/${run.id}`, status: run.status });
}
