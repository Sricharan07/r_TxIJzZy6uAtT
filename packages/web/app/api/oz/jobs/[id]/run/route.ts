import type { AgentType } from "@kiln/shared";
import { currentUserId } from "../../../../../../lib/auth";
import { OzRunBlockedError, runOzSuite } from "../../../../../../lib/oz";

export const runtime = "nodejs";

function isAgent(value: unknown): value is AgentType {
  return value === "claude-code" || value === "codex" || value === "cursor";
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  try {
    const { id } = await params;
    const job = await runOzSuite(id, userId, {
      scenarioId: typeof body.scenarioId === "string" ? body.scenarioId : undefined,
      agentType: isAgent(body.agentType) ? body.agentType : undefined,
      requestedRuns: Number.isInteger(body.requestedRuns) ? Number(body.requestedRuns) : undefined,
    });
    return Response.json({ job });
  } catch (err) {
    if (err instanceof OzRunBlockedError) {
      return Response.json(
        { error: err.message, blockers: err.blockers, missingSecrets: err.missingSecrets },
        { status: err.statusCode },
      );
    }
    return Response.json({ error: err instanceof Error ? err.message : "Could not run suite" }, { status: 400 });
  }
}
