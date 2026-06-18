import { getRunInfrastructureHealth } from "../../../../lib/system-health";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const health = await getRunInfrastructureHealth();
  return Response.json(health, { status: health.ok ? 200 : 503 });
}
