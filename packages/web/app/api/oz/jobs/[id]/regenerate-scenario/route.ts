import { currentUserId } from "../../../../../../lib/auth";
import { regenerateOzScenario } from "../../../../../../lib/oz";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const scenarioId = typeof body.scenarioId === "string" ? body.scenarioId : "";
  if (!scenarioId) return Response.json({ error: "scenarioId is required" }, { status: 400 });
  try {
    const { id } = await params;
    const action = typeof body.action === "string" ? body.action : "regenerate";
    return Response.json({ job: await regenerateOzScenario(id, userId, scenarioId, action) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not update scenario" }, { status: 400 });
  }
}
