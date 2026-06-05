/**
 * Run worker (Decision 1 separate service, Decision 11 event stream).
 *
 * The runner is its own service so a misbehaving agent can't take down the web
 * app (Decision 1). In production it is a BullMQ worker subscribed to a Redis
 * queue: the web app enqueues `{ evalId, config }` jobs and this worker consumes
 * them, runs the agent in a Firecracker microVM (Decision 2), grades the result
 * (Decision 5), and writes the {@link RunResult} back.
 *
 * The Redis/BullMQ wiring is documented and guarded behind an env flag so this
 * module imports and runs cleanly WITHOUT Redis. The actual work lives in the
 * pure {@link executeRun} function, which is fully exercisable in-process.
 */
import {
  aggregateCompletedRunReports,
  type AgentEvent,
  type Eval,
  type EvalConfig,
  type GradeReport,
  type RunResult,
  type Verdict,
} from "@kiln/shared";
import { gradeWithReport } from "@kiln/grader";
import { Worker } from "bullmq";
import { getStore } from "@kiln/shared/store";
import { getAgent } from "./agents/registry.js";
import { createSandbox } from "./sandbox/firecracker.js";
import type { RunnerSandbox } from "./sandbox/firecracker.js";
import type { Agent } from "./agents/interface.js";
import { crawlUrl } from "./context/crawler.js";
import { cloneRepo } from "./context/github.js";

export interface ExecuteRunOptions {
  runId?: string;
  evalId?: string;
  evalTitle?: string;
  onEvent?: (event: AgentEvent) => Promise<void>;
  /** Test seam for exercising timeout/error behavior without external infra. */
  sandbox?: RunnerSandbox;
  /** Test seam for exercising timeout/error behavior without a live agent CLI. */
  agent?: Agent;
}

interface RunJob {
  evalId: string;
  runId: string;
}

function runCountForEval(config: EvalConfig): number {
  const requested = config.metadata.requestedRuns;
  if (requested !== undefined) return Math.min(10, Math.max(1, Math.floor(requested)));
  return process.env.NODE_ENV === "production" ? 3 : 1;
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

function redisConnection() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required when RUNNER_ENABLE_QUEUE=1.");
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

/**
 * Deterministic 32-bit FNV-1a string hash → hex. Used to derive stable run ids
 * from the config (no time/random sources, per conventions).
 */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 to coerce to unsigned before hex formatting.
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Stable run id derived purely from the eval config. */
function deriveRunId(config: EvalConfig): string {
  return `run_${hash(JSON.stringify(config))}`;
}

/** Stable eval id derived purely from the eval config. */
function deriveEvalId(config: EvalConfig): string {
  return `eval_${hash(config.task + "|" + config.language)}`;
}

/** First line of the task, used as a human-readable title for the report. */
function deriveTitle(config: EvalConfig): string {
  const first = config.task.split("\n", 1)[0]?.trim() ?? "Untitled eval";
  return first.length > 80 ? first.slice(0, 77) + "…" : first;
}

class RunTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutSec: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RunTimeoutError(`Run exceeded ${timeoutSec}s timeout.`)),
          timeoutSec * 1_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ingest every {@link ContextSource} into a single prompt block (Decision 15).
 *
 * `url`/`repo` sources are fetched fresh; `file`/`paste` use their stored
 * `content` verbatim. The assembled text is prepended to the task so the agent
 * sees task + context as one prompt.
 */
async function assemblePrompt(config: EvalConfig): Promise<string> {
  const blocks: string[] = [];
  for (const src of config.context) {
    switch (src.type) {
      case "url": {
        const { label, content } = await crawlUrl(src.label, src.crawlDepth ?? "single");
        blocks.push(`### Context — URL: ${label}\n${content}`);
        break;
      }
      case "repo": {
        const { label, content } = await cloneRepo(src.label, src.paths ?? []);
        blocks.push(`### Context — Repo: ${label}\n${content}`);
        break;
      }
      case "file":
      case "paste": {
        blocks.push(`### Context — ${src.label}\n${src.content ?? ""}`);
        break;
      }
    }
  }
  const contextBlock = blocks.length ? blocks.join("\n\n") + "\n\n" : "";
  return `${contextBlock}### Task\n${config.task}`;
}

/**
 * Execute one eval end-to-end and assemble a {@link RunResult}.
 *
 * Pipeline: ingest context → boot the selected sandbox → drive the
 * agent (collecting {@link AgentEvent}s) → grade the finished sandbox → tear
 * down → assemble result. Runs fully in-process; no Redis/infra required.
 *
 * Errors are classified per Decision 18: our own failures become `platform`
 * errors on the result rather than crashing the worker.
 */
export async function executeRun(
  config: EvalConfig,
  options: ExecuteRunOptions = {},
): Promise<RunResult> {
  const id = options.runId ?? deriveRunId(config);
  const evalId = options.evalId ?? deriveEvalId(config);
  const evalTitle = options.evalTitle ?? deriveTitle(config);

  const startedAt = new Date().toISOString();

  const sandbox = options.sandbox ?? createSandbox(id);
  let events: AgentEvent[] = [];
  let streamedEventCount = 0;
  let verdicts: Verdict[] = [];
  let gradeReport: GradeReport | undefined;
  let tokens = 0;
  let totalSteps = 0;
  let errorType: RunResult["errorType"] = null;
  let status: RunResult["status"] = "running";

  try {
    await sandbox.boot();

    const prompt = await assemblePrompt(config);
    const agent = options.agent ?? getAgent(config.metadata.agentType);

    const run = await withTimeout(
      agent.startTask({
        config,
        sandbox,
        prompt,
        async onEvent(event) {
          streamedEventCount += 1;
          events.push(event);
          await options.onEvent?.(event);
        },
      }),
      config.metadata.timeoutSec,
    );
    await run.collectArtifacts();

    events = run.events;
    if (options.onEvent && streamedEventCount === 0) {
      for (const event of events) {
        await options.onEvent(event);
      }
    }
    tokens = run.tokens;
    totalSteps = run.steps;

    // Grade the finished sandbox (Decision 5). The grader inspects the same
    // SandboxHandle the agent mutated and returns one verdict per assertion.
    const grading = await gradeWithReport(config, sandbox, {
      runId: id,
      events,
      runStats: {
        durationSec: events.length ? Math.max(...events.map((event) => event.t)) : 0,
        totalSteps,
        tokens,
      },
    });
    verdicts = grading.verdicts;
    gradeReport = grading.gradeReport;
    status = "completed";
  } catch (err) {
    // Decision 18: classify our own failures as platform errors.
    status = "errored";
    errorType = err instanceof RunTimeoutError ? "timeout" : "platform";
    events = [
      ...events,
      {
        t: 0,
        kind: "fail",
        text: "Run failed before completion",
        annotation: err instanceof Error ? err.message : String(err),
      },
    ];
  } finally {
    try {
      await sandbox.teardown();
    } catch (err) {
      if (status !== "errored") {
        status = "errored";
        errorType = "platform";
        events.push({
          t: 0,
          kind: "fail",
          text: "Sandbox teardown failed",
          annotation: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const durationSec = events.length ? Math.max(...events.map((e) => e.t)) : 0;
  const finishedAt = new Date().toISOString();

  return {
    id,
    evalId,
    evalTitle,
    task: config.task,
    agentType: config.metadata.agentType,
    status,
    errorType,
    startedAt,
    finishedAt,
    durationSec,
    totalSteps,
    tokens,
    events,
    verdicts,
    gradeReport,
  };
}

/**
 * Start the BullMQ worker (Decision 1).
 *
 * Only wires up Redis when `RUNNER_ENABLE_QUEUE=1`, so importing this module
 * and running {@link executeRun} directly never requires queue infrastructure.
 */
export async function startWorker(): Promise<void> {
  if (process.env.RUNNER_ENABLE_QUEUE !== "1") {
    // Queue disabled: nothing to connect to. The worker is a no-op so the
    // service can boot in environments without Redis.
    return;
  }

  const worker = new Worker<RunJob>(
    "kiln-runs",
    async (job) => {
      const store = getStore();
      const evalRecord = await store.getEval(job.data.evalId);
      const existingRun = await store.getRun(job.data.runId);
      if (!evalRecord || !existingRun) {
        throw new Error(`Missing eval/run for job ${job.id}`);
      }
      await store.saveRun({ ...existingRun, status: "running", startedAt: new Date().toISOString() });
      const result = await executeRun(evalRecord.config, {
        runId: existingRun.id,
        evalId: evalRecord.id,
        evalTitle: existingRun.evalTitle,
        async onEvent(event) {
          const current = await store.getRun(existingRun.id);
          if (!current) return;
          await store.saveRun({ ...current, events: [...current.events, event] });
        },
      });
      await store.saveRun(result);
      await refreshEvalGradeReports(evalRecord);
      return result;
    },
    { connection: redisConnection() },
  );
  await worker.waitUntilReady();
}
