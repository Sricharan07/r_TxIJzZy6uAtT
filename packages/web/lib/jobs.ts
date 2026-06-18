import { aggregateCompletedRunReports, type AgentEvent, type Eval, type EvalConfig, type RunResult } from "@kiln/shared";
import { getStore, type KilnStore } from "@kiln/shared/store";

const globalJobs = globalThis as typeof globalThis & { __kilnJobs?: Set<string> };
const RETAIN_COMPLETED_JOBS = { age: 60 * 60 * 24, count: 1_000 };
const RETAIN_FAILED_JOBS = { age: 60 * 60 * 24 * 7, count: 5_000 };
type ExecuteRun = (
  config: EvalConfig,
  options: {
    runId: string;
    evalId: string;
    evalTitle: string;
    onEvent(event: AgentEvent): Promise<void>;
  },
) => Promise<RunResult>;

function jobs(): Set<string> {
  globalJobs.__kilnJobs ??= new Set<string>();
  return globalJobs.__kilnJobs;
}

function redisConnection() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

async function saveStatus(run: RunResult, status: RunResult["status"]): Promise<void> {
  const current = await getStore().getRun(run.id);
  if (current?.status === "canceled") return;
  await getStore().saveRun({
    ...run,
    status,
    startedAt: status === "running" ? new Date().toISOString() : run.startedAt,
  });
}

async function savePlatformError(run: RunResult, err: unknown): Promise<void> {
  const current = await getStore().getRun(run.id);
  if (current?.status === "canceled") return;
  await getStore().saveRun({
    ...run,
    status: "errored",
    errorType: "platform",
    finishedAt: new Date().toISOString(),
    events: [
      ...run.events,
      {
        t: 0,
        kind: "fail",
        text: "Run failed before completion",
        annotation: err instanceof Error ? err.message : String(err),
      },
    ],
    verdicts: [],
  });
}

export function runCountForEval(config: EvalConfig): number {
  const requested = config.metadata.requestedRuns;
  if (requested !== undefined) return Math.min(10, Math.max(1, Math.floor(requested)));
  return process.env.NODE_ENV === "production" ? 3 : 1;
}

export async function createRunsForEval(store: KilnStore, evalRecord: Eval): Promise<RunResult[]> {
  const count = runCountForEval(evalRecord.config);
  const runs: RunResult[] = [];
  for (let i = 0; i < count; i++) {
    runs.push(await store.createRun(evalRecord));
  }
  return runs;
}

async function refreshEvalGradeReports(evalRecord: Eval): Promise<void> {
  const store = getStore();
  const runs = await store.listRuns(evalRecord.id);
  const updated = aggregateCompletedRunReports(runs, runCountForEval(evalRecord.config));
  for (const run of updated) {
    if (run.gradeReport && runs.find((existing) => existing.id === run.id)?.gradeReport !== run.gradeReport) {
      await store.saveRun(run);
    }
  }
}

export async function enqueueRun(evalRecord: Eval, run: RunResult): Promise<void> {
  const connection = redisConnection();
  const mode = process.env.KILN_QUEUE_MODE ?? (process.env.NODE_ENV === "production" ? "redis" : "local");
  if (mode === "redis") {
    if (!connection) throw new Error("REDIS_URL is required when KILN_QUEUE_MODE=redis.");
    const bullmqSpecifier = "bullmq";
    const { Queue } = (await import(bullmqSpecifier)) as {
      Queue: new (
        name: string,
        options: Record<string, unknown>,
      ) => {
        add(name: string, data: unknown, options: Record<string, unknown>): Promise<unknown>;
        close(): Promise<void>;
      };
    };
    const queue = new Queue("kiln-runs", { connection });
    try {
      await queue.add(
        "run",
        { evalId: evalRecord.id, runId: run.id },
        {
          jobId: run.id,
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: RETAIN_COMPLETED_JOBS,
          removeOnFail: RETAIN_FAILED_JOBS,
        },
      );
    } catch (err) {
      await savePlatformError(run, err);
      throw err;
    } finally {
      await queue.close();
    }
    return;
  }
  if (mode !== "local") {
    throw new Error(`Unknown KILN_QUEUE_MODE "${mode}". Expected "local" or "redis".`);
  }

  const active = jobs();
  if (active.has(run.id)) return;
  active.add(run.id);

  void (async () => {
    try {
      const runnerSpecifier = "@kiln/runner";
      const { executeRun } = (await import(runnerSpecifier)) as { executeRun: ExecuteRun };
      const existing = await getStore().getRun(run.id);
      if (existing?.status === "canceled") return;
      await saveStatus(run, "running");
      const result = await executeRun(evalRecord.config, {
        runId: run.id,
        evalId: evalRecord.id,
        evalTitle: run.evalTitle,
        async onEvent(event) {
          const current = await getStore().getRun(run.id);
          if (!current || current.status === "canceled") throw new Error("Run was canceled.");
          await getStore().saveRun({ ...current, events: [...current.events, event] });
        },
      });
      const latest = await getStore().getRun(run.id);
      if (latest?.status === "canceled") return;
      await getStore().saveRun(result);
      await refreshEvalGradeReports(evalRecord);
    } catch (err) {
      await savePlatformError(run, err);
      await refreshEvalGradeReports(evalRecord);
    } finally {
      active.delete(run.id);
    }
  })();
}
