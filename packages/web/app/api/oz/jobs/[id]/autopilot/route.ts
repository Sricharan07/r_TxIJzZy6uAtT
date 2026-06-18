import { currentUserId } from "../../../../../../lib/auth";
import { OzRunBlockedError, requireOwnedOzJob, runOzSuite, startOzDiscovery } from "../../../../../../lib/oz";
import { getStore } from "@kiln/shared/store";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  try {
    const { id } = await params;
    const job = await requireOwnedOzJob(id, userId);
    await getStore().saveOzJob({
      ...job,
      mode: "autopilot",
      state: { ...job.state, input: { ...job.state.input, mode: "autopilot" } },
    });
    if (job.status === "created" || job.status === "failed" || job.status === "blocked") {
      startOzDiscovery(id);
      return Response.json({ job: await requireOwnedOzJob(id, userId) });
    }
    if (job.status === "awaiting_approval") {
      return Response.json({ job: await runOzSuite(id, userId, {}) });
    }
    return Response.json({ job: await requireOwnedOzJob(id, userId) });
  } catch (err) {
    if (err instanceof OzRunBlockedError) {
      return Response.json(
        { error: err.message, blockers: err.blockers, missingSecrets: err.missingSecrets },
        { status: err.statusCode },
      );
    }
    return Response.json({ error: err instanceof Error ? err.message : "Could not enable autopilot" }, { status: 400 });
  }
}
