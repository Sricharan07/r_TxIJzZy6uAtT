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
import type { EvalConfig, RunResult, AgentEvent, Verdict } from "@kiln/shared";
import { grade } from "@kiln/grader";
import { getAgent } from "./agents/registry";
import { FirecrackerSandbox } from "./sandbox/firecracker";
import { crawlUrl } from "./context/crawler";
import { cloneRepo } from "./context/github";

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

/**
 * Ingest every {@link ContextSource} into a single prompt block (Decision 15).
 *
 * `url`/`repo` sources are (stub-)fetched fresh; `file`/`paste` use their stored
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
 * Pipeline: ingest context → boot (simulated) Firecracker sandbox → drive the
 * agent (collecting {@link AgentEvent}s) → grade the finished sandbox → tear
 * down → assemble result. Runs fully in-process; no Redis/infra required.
 *
 * Errors are classified per Decision 18: our own failures become `platform`
 * errors on the result rather than crashing the worker.
 */
export interface ExecuteRunOptions {
  /**
   * Distinguishes repeated runs of the same config (re-runs) so each gets a
   * unique run id — required for the diff/comparison view (Decision 17).
   */
  attempt?: number;
  /** Override the derived run id. */
  runId?: string;
  /**
   * ISO start timestamp. The runner itself stays wall-clock-free (deterministic
   * for tests); callers that want real ordering pass a real timestamp here.
   */
  startedAt?: string;
}

export async function executeRun(
  config: EvalConfig,
  opts: ExecuteRunOptions = {},
): Promise<RunResult> {
  const evalId = deriveEvalId(config);
  const id = opts.runId ?? `${deriveRunId(config)}${opts.attempt ? `_${opts.attempt}` : ""}`;
  const evalTitle = deriveTitle(config);

  // Deterministic by default; a real timestamp can be supplied by the caller.
  const startedAt = opts.startedAt ?? "1970-01-01T00:00:00.000Z";

  const sandbox = new FirecrackerSandbox(id);
  let events: AgentEvent[] = [];
  let verdicts: Verdict[] = [];
  let tokens = 0;
  let totalSteps = 0;
  let errorType: RunResult["errorType"] = null;
  let status: RunResult["status"] = "running";

  try {
    await sandbox.boot();

    const prompt = await assemblePrompt(config);
    const agent = getAgent(config.metadata.agentType);

    // Drive the agent. The microVM enforces the hard timeout in production
    // (config.metadata.timeoutSec); here the simulated run always completes.
    const run = await agent.startTask({ config, sandbox, prompt });
    await run.collectArtifacts();

    events = run.events;
    tokens = run.tokens;
    totalSteps = run.steps;

    // Grade the finished sandbox (Decision 5). The grader inspects the same
    // SandboxHandle the agent mutated and returns one verdict per assertion.
    verdicts = await grade(config.assertions, sandbox);
    status = "completed";
  } catch (err) {
    // Decision 18: classify our own failures as platform errors.
    status = "errored";
    errorType = "platform";
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
    await sandbox.teardown();
  }

  // Deterministic duration from the last event timestamp (no wall clock).
  const durationSec = events.length ? Math.max(...events.map((e) => e.t)) : 0;
  // By here the run has resolved (completed or errored), so it always has a
  // finish time. Reuse the deterministic startedAt to avoid a wall-clock source.
  const finishedAt = startedAt;

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
  };
}

/**
 * Start the BullMQ worker (Decision 1) — DOCUMENTED, env-guarded.
 *
 * Only wires up Redis when `RUNNER_ENABLE_QUEUE=1`, so importing this module
 * (and running {@link executeRun} directly) never requires Redis. The BullMQ
 * import is intentionally dynamic and described rather than hard-wired, because
 * `bullmq`/Redis are not available in this sandbox.
 */
export async function startWorker(): Promise<void> {
  if (process.env.RUNNER_ENABLE_QUEUE !== "1") {
    // Queue disabled: nothing to connect to. The worker is a no-op so the
    // service can boot in environments without Redis.
    return;
  }

  // PRODUCTION (pseudo-code; bullmq not installed here):
  //
  //   const { Worker } = await import("bullmq");
  //   const connection = { url: process.env.REDIS_URL };
  //   new Worker("kiln-runs", async (job) => {
  //     const result = await executeRun(job.data.config as EvalConfig);
  //     // persist `result` to Postgres / notify the web app
  //     return result;
  //   }, { connection });
  //
  // Left undialed-into here on purpose: see comment above.
  throw new Error("Queue mode requested but bullmq/Redis are not available in this environment.");
}
