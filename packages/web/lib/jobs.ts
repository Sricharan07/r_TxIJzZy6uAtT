import { executeRun } from "@kiln/runner";
import type { Eval, RunResult } from "@kiln/shared";
import { getStore } from "@kiln/shared/store";
import { Queue } from "bullmq";

const globalJobs = globalThis as typeof globalThis & { __kilnJobs?: Set<string> };

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
  await getStore().saveRun({
    ...run,
    status,
    startedAt: status === "running" ? new Date().toISOString() : run.startedAt,
  });
}

export function enqueueRun(evalRecord: Eval, run: RunResult): void {
  const connection = redisConnection();
  const mode = process.env.KILN_QUEUE_MODE ?? (process.env.NODE_ENV === "production" ? "redis" : "local");
  if (mode === "redis") {
    if (!connection) throw new Error("REDIS_URL is required when KILN_QUEUE_MODE=redis.");
    const queue = new Queue("kiln-runs", { connection });
    void queue.add("run", { evalId: evalRecord.id, runId: run.id }).finally(() => queue.close());
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
      await saveStatus(run, "running");
      const result = await executeRun(evalRecord.config, {
        runId: run.id,
        evalId: evalRecord.id,
        evalTitle: run.evalTitle,
        async onEvent(event) {
          const current = await getStore().getRun(run.id);
          if (!current) return;
          await getStore().saveRun({ ...current, events: [...current.events, event] });
        },
      });
      await getStore().saveRun(result);
    } catch (err) {
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
    } finally {
      active.delete(run.id);
    }
  })();
}
