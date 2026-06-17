import type { OzSuiteDraft } from "@kiln/shared";
import { currentUserId } from "../../../../../../lib/auth";
import { editOzSuite } from "../../../../../../lib/oz";

export const runtime = "nodejs";

function isSuiteDraft(value: unknown): value is OzSuiteDraft {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { scenarios?: unknown }).scenarios) &&
    typeof (value as { confidence?: unknown }).confidence === "number"
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isSuiteDraft(body.suiteDraft)) {
    return Response.json({ error: "suiteDraft is required" }, { status: 400 });
  }
  try {
    const { id } = await params;
    return Response.json({ job: await editOzSuite(id, userId, body.suiteDraft) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not edit suite" }, { status: 400 });
  }
}
