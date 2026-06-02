/**
 * Run/eval persistence (Decision 7).
 *
 * PRODUCTION: eval configs + run metadata live in Postgres and full traces in
 * S3 (see {@link ./db/schema} and {@link ./s3}). The web app server-renders
 * reports from these reads.
 *
 * HERE: a process-wide in-memory store, held on `globalThis` so every server
 * bundle (route handlers, server components, the OG route) shares ONE instance
 * within the running Next.js process. It is seeded with the sample data so the
 * pre-existing sample report/diff URLs keep working, and newly created evals
 * (POST /api/evals → runner.executeRun) persist here and get their own real
 * report. No filesystem access, so this module is safe in both the Node and
 * Edge runtimes. The read/write surface matches what a Postgres-backed
 * implementation would expose, so swapping the backend never touches callers.
 */
import type { Eval, RunResult } from "./types";
import { MOCK_EVAL, MOCK_RUN, MOCK_RUN_FIXED, MOCK_RUN_ERROR } from "./mock";

interface KilnStore {
  evals: Map<string, Eval>;
  runs: Map<string, RunResult>;
}

function seed(): KilnStore {
  const evals = new Map<string, Eval>();
  const runs = new Map<string, RunResult>();
  evals.set(MOCK_EVAL.id, MOCK_EVAL);
  for (const r of [MOCK_RUN, MOCK_RUN_FIXED, MOCK_RUN_ERROR]) runs.set(r.id, r);
  return { evals, runs };
}

const g = globalThis as unknown as { __kilnStore?: KilnStore };
const store: KilnStore = (g.__kilnStore ??= seed());

export function saveEval(e: Eval): void {
  store.evals.set(e.id, e);
}

export function getStoredEval(id: string): Eval | null {
  return store.evals.get(id) ?? null;
}

export function listEvals(): Eval[] {
  return [...store.evals.values()];
}

export function saveRun(run: RunResult): void {
  store.runs.set(run.id, run);
}

export function getStoredRun(id: string): RunResult | null {
  return store.runs.get(id) ?? null;
}

/** All runs for an eval, oldest first — powers the diff/comparison view (D17). */
export function listRunsForEval(evalId: string): RunResult[] {
  return [...store.runs.values()]
    .filter((r) => r.evalId === evalId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * Resolve a run by id (Decision 6 — reports are rendered from a run).
 *
 * Falls back to the sample run only for unknown ids so demo links and the nav
 * never dead-end; real created runs resolve to themselves.
 */
export function getRun(id: string): RunResult | null {
  return getStoredRun(id) ?? store.runs.get(MOCK_RUN.id) ?? null;
}

/** Resolve an eval by id, falling back to the sample eval for unknown ids. */
export function getEval(id: string): Eval | null {
  return getStoredEval(id) ?? store.evals.get(MOCK_EVAL.id) ?? null;
}
