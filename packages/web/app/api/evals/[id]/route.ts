import { getStore } from "@kiln/shared/store";
import { currentUserId } from "../../../../lib/auth";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const evalRecord = await getStore().getEval(id);
  if (!evalRecord) {
    return Response.json({ error: "Eval not found" }, { status: 404 });
  }
  const userId = await currentUserId();
  const isShareToken = evalRecord.shareToken === id;
  if (!isShareToken && evalRecord.userId !== userId) {
    return Response.json(
      { error: userId ? "Eval not found" : "GitHub sign-in required" },
      { status: userId ? 404 : 401 },
    );
  }
  const runs = await getStore().listRuns(evalRecord.id);
  return Response.json({ eval: evalRecord, runs });
}
