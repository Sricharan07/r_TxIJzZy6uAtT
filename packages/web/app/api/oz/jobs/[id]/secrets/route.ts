import { getStore } from "@kiln/shared/store";
import { currentUserId } from "../../../../../../lib/auth";
import { refreshOwnedOzJob, requireOwnedOzJob } from "../../../../../../lib/oz";

export const runtime = "nodejs";

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function declaredNames(job: Awaited<ReturnType<typeof requireOwnedOzJob>>): Set<string> {
  return new Set((job.state.productProfile?.requiredEnv ?? []).map((env) => env.name));
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  try {
    const { id } = await params;
    const job = await refreshOwnedOzJob(id, userId);
    const secrets = await getStore().listProductSecretSummaries(userId, "oz_job", id);
    return Response.json({ job, secrets });
  } catch {
    return Response.json({ error: "Oz job not found" }, { status: 404 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isRecord(body) || !isRecord(body.secrets)) {
    return Response.json({ error: "secrets object is required" }, { status: 400 });
  }
  try {
    const { id } = await params;
    const job = await requireOwnedOzJob(id, userId);
    const allowed = declaredNames(job);
    const values: Record<string, string> = {};
    const clears: string[] = [];
    for (const [name, rawValue] of Object.entries(body.secrets)) {
      if (!ENV_NAME.test(name)) return Response.json({ error: `Invalid env name: ${name}` }, { status: 400 });
      if (!allowed.has(name)) return Response.json({ error: `${name} is not declared by this product profile.` }, { status: 400 });
      if (typeof rawValue !== "string") return Response.json({ error: `${name} must be a string.` }, { status: 400 });
      const value = rawValue.trim();
      if (value) values[name] = value;
      else clears.push(name);
    }
    const store = getStore();
    if (Object.keys(values).length > 0) {
      await store.upsertProductSecrets({ userId, scopeType: "oz_job", scopeId: id, values });
    }
    if (clears.length > 0) {
      await store.deleteProductSecrets({ userId, scopeType: "oz_job", scopeId: id, names: clears });
    }
    const refreshed = await refreshOwnedOzJob(id, userId);
    const summaries = await store.listProductSecretSummaries(userId, "oz_job", id);
    return Response.json({ job: refreshed, secrets: summaries });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Could not save secrets" }, { status: 400 });
  }
}
