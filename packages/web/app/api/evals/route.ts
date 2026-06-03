import type { EvalConfig } from "@kiln/shared";
import { getStore } from "@kiln/shared/store";
import { enqueueRun } from "../../../lib/jobs";
import { currentUserId } from "../../../lib/auth";

export const runtime = "nodejs";

const LANGUAGES = new Set(["node", "python", "go", "other"]);
const AGENTS = new Set(["claude-code", "codex", "cursor"]);
const CONTEXT_TYPES = new Set(["url", "repo", "file", "paste"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function validateContextSource(value: unknown): boolean {
  if (!isRecord(value) || !CONTEXT_TYPES.has(String(value.type)) || !isNonEmptyString(value.label)) {
    return false;
  }
  if (!isOptionalString(value.content)) return false;
  if (value.type === "url") return value.crawlDepth === undefined || value.crawlDepth === "single" || value.crawlDepth === "linked";
  if (value.type === "repo") return value.paths === undefined || (Array.isArray(value.paths) && value.paths.every((path) => typeof path === "string"));
  return true;
}

function validateAssertion(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.name) || !isRecord(value.config)) return false;
  const config = value.config;
  switch (value.type) {
    case "shell":
      return isNonEmptyString(config.command) && isOptionalString(config.cwd);
    case "http":
      return (
        isNonEmptyString(config.url) &&
        (config.expectStatus === undefined ||
          (Number.isInteger(config.expectStatus) && Number(config.expectStatus) >= 100 && Number(config.expectStatus) <= 599)) &&
        isOptionalString(config.expectBodyContains)
      );
    case "file":
      return isNonEmptyString(config.path) && isOptionalString(config.contains);
    case "llm":
      return isNonEmptyString(config.criterion);
    default:
      return false;
  }
}

function validateEvalConfig(body: unknown): body is EvalConfig {
  if (!isRecord(body)) return false;
  const cfg = body as Partial<EvalConfig>;
  if (typeof cfg.task !== "string" || cfg.task.trim().length === 0) return false;
  if (typeof cfg.language !== "string" || !LANGUAGES.has(cfg.language)) return false;
  if (!Array.isArray(cfg.context) || !cfg.context.every(validateContextSource)) return false;
  if (!Array.isArray(cfg.assertions) || cfg.assertions.length === 0 || !cfg.assertions.every(validateAssertion)) return false;
  if (!isRecord(cfg.metadata)) return false;
  if (!AGENTS.has(cfg.metadata.agentType)) return false;
  if (!Number.isFinite(cfg.metadata.timeoutSec) || cfg.metadata.timeoutSec <= 0 || cfg.metadata.timeoutSec > 3600) return false;
  return true;
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!validateEvalConfig(body)) {
    return Response.json({ error: "Invalid eval config" }, { status: 400 });
  }

  const store = getStore();
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  const evalRecord = await store.createEval(userId, body);
  const run = await store.createRun(evalRecord);
  enqueueRun(evalRecord, run);

  return Response.json(
    {
      evalId: evalRecord.id,
      runId: run.id,
      shareToken: evalRecord.shareToken,
      status: run.status,
      reportUrl: `/reports/${run.id}`,
      evalUrl: `/evals/${evalRecord.id}`,
    },
    { status: 201 },
  );
}

export async function GET(): Promise<Response> {
  const store = getStore();
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "GitHub sign-in required" }, { status: 401 });
  return Response.json(await store.listEvals(userId));
}
