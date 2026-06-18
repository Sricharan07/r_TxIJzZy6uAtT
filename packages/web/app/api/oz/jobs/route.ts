import type { AgentType, OzMode } from "@kiln/shared";
import { currentUserId } from "../../../../lib/auth";
import { createOzJob } from "../../../../lib/oz";

export const runtime = "nodejs";

function isMode(value: unknown): value is OzMode {
  return value === "copilot" || value === "autopilot" || value === "manual";
}

function isAgent(value: unknown): value is AgentType {
  return value === "claude-code" || value === "codex" || value === "cursor";
}

function cookieNames(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(";")
    .map((part) => part.trim().split("=", 1)[0])
    .filter(Boolean)
    .sort();
}

export async function POST(req: Request): Promise<Response> {
  const userId = await currentUserId();
  if (!userId) {
    const cookieHeader = req.headers.get("cookie");
    const names = cookieNames(cookieHeader);
    console.warn("Oz job creation rejected unauthenticated request", {
      cookieNames: names,
      hasKilnSessionCookie: names.includes("kiln_session"),
      host: req.headers.get("host"),
      origin: req.headers.get("origin"),
      referer: req.headers.get("referer"),
      secFetchMode: req.headers.get("sec-fetch-mode"),
      secFetchSite: req.headers.get("sec-fetch-site"),
    });
    return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const productUrl = typeof body.productUrl === "string" ? body.productUrl.trim() : "";
  if (!productUrl) return Response.json({ error: "productUrl is required" }, { status: 400 });
  try {
    new URL(productUrl.startsWith("http") ? productUrl : `https://${productUrl}`);
  } catch {
    return Response.json({ error: "productUrl must be a valid URL" }, { status: 400 });
  }
  const agentTargets = Array.isArray(body.agentTargets) ? body.agentTargets.filter(isAgent) : undefined;
  const job = await createOzJob({
    userId,
    productUrl,
    mode: isMode(body.mode) ? body.mode : "copilot",
    userGoal: typeof body.userGoal === "string" ? body.userGoal : undefined,
    preferredLanguage:
      body.preferredLanguage === "node" ||
      body.preferredLanguage === "python" ||
      body.preferredLanguage === "go" ||
      body.preferredLanguage === "curl"
        ? body.preferredLanguage
        : undefined,
    agentTargets,
  });
  return Response.json({ job }, { status: 201 });
}
