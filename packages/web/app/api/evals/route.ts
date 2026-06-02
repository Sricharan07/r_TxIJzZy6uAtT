/**
 * Decision 4 — Eval CRUD + job enqueue.
 *
 * Next.js 14 App Router route handler for `/api/evals`.
 *
 * PRODUCTION: POST persists the EvalConfig to Postgres, creates a `runs` row,
 * and enqueues a BullMQ job that the Firecracker-backed runner consumes
 * asynchronously; the report page then streams live updates (Decision 11).
 *
 * HERE: there is no Redis/Firecracker fleet in this sandbox, so we run the same
 * `executeRun` pipeline the queue worker would run — inline — and persist the
 * result to the shared in-process store (Decision 7). The created eval gets its
 * OWN real report at `/reports/<runId>`; this is no longer a fixed sample.
 */

import {
  saveEval,
  saveRun,
  listRunsForEval,
  listEvals,
  type Eval,
  type EvalConfig,
  type AgentType,
  type Language,
} from "@kiln/shared";
import { executeRun } from "@kiln/runner";

// This handler does real work (sandbox simulation + grading) — keep it on the
// Node.js runtime, not edge.
export const runtime = "nodejs";

/** Deterministic, dependency-free FNV-1a string hash → fixed-width hex. */
function hashId(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const LANGUAGES: Language[] = ["node", "python", "go", "other"];
const AGENTS: AgentType[] = ["claude-code", "codex", "cursor"];

/** Coerce + validate an unknown body into a full EvalConfig. */
function parseConfig(body: unknown): { config: EvalConfig } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "Request body must be a JSON object" };
  const b = body as Record<string, unknown>;

  if (typeof b.task !== "string" || b.task.trim().length === 0) {
    return { error: "Field 'task' is required and must be a non-empty string" };
  }
  if (typeof b.language !== "string" || !LANGUAGES.includes(b.language as Language)) {
    return { error: `Field 'language' is required and must be one of: ${LANGUAGES.join(", ")}` };
  }
  if (!Array.isArray(b.assertions) || b.assertions.length === 0) {
    return { error: "Field 'assertions' is required and must be a non-empty array" };
  }

  const meta = (b.metadata ?? {}) as Record<string, unknown>;
  const agentType = AGENTS.includes(meta.agentType as AgentType)
    ? (meta.agentType as AgentType)
    : "claude-code";
  const timeoutSec = typeof meta.timeoutSec === "number" ? meta.timeoutSec : 300;

  const config: EvalConfig = {
    task: b.task,
    language: b.language as Language,
    context: Array.isArray(b.context) ? (b.context as EvalConfig["context"]) : [],
    assertions: b.assertions as EvalConfig["assertions"],
    metadata: { agentType, timeoutSec },
  };
  return { config };
}

/**
 * POST /api/evals — create an eval, run it, and persist the result.
 * Returns 201 with { evalId, runId, status } on success, 400 on validation
 * failure.
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseConfig(body);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const { config } = parsed;

  const evalId = `ev_${hashId(config.task + "|" + config.language)}`;
  const evalRecord: Eval = {
    id: evalId,
    userId: "anon",
    config,
    createdAt: new Date().toISOString(),
    shareToken: `cfg_${hashId(evalId)}`,
  };
  saveEval(evalRecord);

  // Each submission is a fresh run (re-runs of the same config get distinct ids
  // so the diff view can compare them — Decision 17).
  const attempt = listRunsForEval(evalId).length;
  const run = await executeRun(config, { attempt, startedAt: new Date().toISOString() });
  saveRun(run);

  return Response.json({ evalId, runId: run.id, status: run.status }, { status: 201 });
}

/**
 * GET /api/evals — list evals.
 * PRODUCTION: SELECT scoped to the authenticated user. HERE: from the store.
 */
export async function GET(): Promise<Response> {
  const evals = listEvals().map((e) => ({
    id: e.id,
    title: e.config.task.split("\n", 1)[0],
    createdAt: e.createdAt,
  }));
  return Response.json(evals);
}
