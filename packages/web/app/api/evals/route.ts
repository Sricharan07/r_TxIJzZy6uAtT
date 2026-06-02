/**
 * Decision 4 — Eval CRUD + job enqueue.
 *
 * Next.js 14 App Router route handler for `/api/evals`.
 *
 * PRODUCTION: POST persists the EvalConfig to Postgres, creates a `runs` row,
 * and enqueues a BullMQ job that the Firecracker-backed runner consumes. GET
 * lists the caller's evals from Postgres.
 *
 * HERE (MVP scaffold): no DB or queue runs in this sandbox, so POST validates
 * the body and returns deterministic ids derived from a simple string hash of
 * the task (no time/random sources). GET returns the single sample eval from
 * "@kiln/shared". The request/response shapes match the production contract.
 */

import { MOCK_EVAL, MOCK_RUN } from "@kiln/shared";
import type { EvalConfig } from "@kiln/shared";

/**
 * Deterministic, dependency-free string hash (FNV-1a, 32-bit) rendered as a
 * fixed-width hex string. Used so the same task always yields the same id —
 * no Date.now()/Math.random(). Not cryptographically secure; ids only.
 */
function hashId(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to avoid float precision loss.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Validate that an unknown JSON body carries the EvalConfig fields the runner
 * requires. Returns an error string when invalid, or null when acceptable.
 */
function validateEvalConfig(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return "Request body must be a JSON object";
  }
  const cfg = body as Partial<EvalConfig>;
  if (typeof cfg.task !== "string" || cfg.task.trim().length === 0) {
    return "Field 'task' is required and must be a non-empty string";
  }
  if (typeof cfg.language !== "string") {
    return "Field 'language' is required";
  }
  if (!Array.isArray(cfg.assertions)) {
    return "Field 'assertions' is required and must be an array";
  }
  return null;
}

/**
 * POST /api/evals — create an eval and enqueue a run.
 * Returns 201 with { evalId, runId, status:"pending" } on success, 400 on
 * validation failure.
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const error = validateEvalConfig(body);
  if (error) {
    return Response.json({ error }, { status: 400 });
  }

  const { task } = body as EvalConfig;

  // PRODUCTION: INSERT eval row, INSERT run row, queue.add("run", { runId }).
  // HERE: derive stable ids from the task text so repeated calls are stable.
  const evalId = `ev_${hashId(task)}`;
  const runId = `rn_${hashId(`${evalId}:run`)}`;

  return Response.json({ evalId, runId, status: "pending" }, { status: 201 });
}

/**
 * GET /api/evals — list evals.
 *
 * PRODUCTION: SELECT from Postgres scoped to the authenticated user.
 * HERE: returns the single sample eval. The title lives on the run record
 * (`evalTitle`); ids/createdAt come from the eval record.
 */
export async function GET(): Promise<Response> {
  return Response.json([
    {
      id: MOCK_EVAL.id,
      title: MOCK_RUN.evalTitle,
      createdAt: MOCK_EVAL.createdAt,
    },
  ]);
}
