import { getStore } from "@kiln/shared/store";

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
  const runs = await getStore().listRuns(evalRecord.id);
  return Response.json({ eval: evalRecord, runs });
}
