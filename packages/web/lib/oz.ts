import { buildOzReport, observeRunEvent, OzOrchestrator, scenarioToEvalConfig } from "@kiln/oz-agent";
import type { AgentType, OzJob, OzMode, OzScenario, OzSuiteDraft } from "@kiln/shared";
import { getStore } from "@kiln/shared/store";
import { createRunsForEval, enqueueRun } from "./jobs";

const globalOz = globalThis as typeof globalThis & { __ozActiveJobs?: Set<string> };

function activeJobs(): Set<string> {
  globalOz.__ozActiveJobs ??= new Set<string>();
  return globalOz.__ozActiveJobs;
}

function redisConnection(): { host: string; port: number; password?: string; tls?: Record<string, never> } | null {
  const raw = process.env.REDIS_URL;
  if (!raw) return null;
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    tls: url.protocol === "rediss:" ? {} : undefined,
  };
}

const DESTRUCTIVE_COMMAND = /\b(rm\s+-rf\s+\/|mkfs|shutdown|reboot|drop\s+database|delete\s+from\s+\w+\s*;)\b/i;

function validateSuiteDraft(suiteDraft: OzSuiteDraft | undefined): string[] {
  if (!suiteDraft) return ["Suite is not ready."];
  const errors: string[] = [];
  if (!Array.isArray(suiteDraft.scenarios) || suiteDraft.scenarios.length === 0) {
    errors.push("At least one scenario is required.");
  }
  if (!Number.isFinite(suiteDraft.confidence) || suiteDraft.confidence < 0 || suiteDraft.confidence > 1) {
    errors.push("Suite confidence must be between 0 and 1.");
  }
  for (const [index, scenario] of suiteDraft.scenarios.entries()) {
    const label = scenario.title || scenario.id || `Scenario ${index + 1}`;
    if (!scenario.id?.trim()) errors.push(`${label}: id is required.`);
    if (!scenario.title?.trim()) errors.push(`${label}: title is required.`);
    if (!scenario.task?.trim()) errors.push(`${label}: task is required.`);
    if (!Array.isArray(scenario.assertions) || scenario.assertions.length < 2) {
      errors.push(`${label}: at least two assertions are required.`);
    }
    for (const assertion of scenario.assertions ?? []) {
      if (!assertion.name?.trim()) errors.push(`${label}: assertion name is required.`);
      if (assertion.type === "shell") {
        const command = "command" in assertion.config ? assertion.config.command : "";
        if (!command.trim()) errors.push(`${label}: shell assertion command is required.`);
        if (DESTRUCTIVE_COMMAND.test(command)) errors.push(`${label}: destructive shell assertion is not allowed.`);
      } else if (assertion.type === "file") {
        if (!("path" in assertion.config) || !assertion.config.path.trim()) errors.push(`${label}: file assertion path is required.`);
      } else if (assertion.type === "http") {
        if (!("url" in assertion.config) || !assertion.config.url.trim()) errors.push(`${label}: HTTP assertion URL is required.`);
      } else if (assertion.type === "llm") {
        if (!("criterion" in assertion.config) || !assertion.config.criterion.trim()) errors.push(`${label}: LLM assertion criterion is required.`);
      } else {
        errors.push(`${label}: unsupported assertion type.`);
      }
    }
  }
  return errors;
}

function missingSecretsFor(job: OzJob): string[] {
  return (job.state.productProfile?.requiredEnv ?? [])
    .filter((env) => env.required !== false && !process.env[env.name])
    .map((env) => env.name);
}

function requireValidSuite(suiteDraft: OzSuiteDraft | undefined): OzSuiteDraft {
  const errors = validateSuiteDraft(suiteDraft);
  if (errors.length > 0) throw new Error(errors.join(" "));
  return suiteDraft as OzSuiteDraft;
}

async function removeQueuedRuns(runIds: string[]): Promise<void> {
  if (runIds.length === 0) return;
  const mode = process.env.KILN_QUEUE_MODE ?? (process.env.NODE_ENV === "production" ? "redis" : "local");
  if (mode === "local") return;
  if (mode !== "redis") throw new Error(`Unknown KILN_QUEUE_MODE "${mode}". Expected "local" or "redis".`);
  const connection = redisConnection();
  if (!connection) return;
  const bullmqSpecifier = "bullmq";
  const { Queue } = (await import(bullmqSpecifier)) as {
    Queue: new (
      name: string,
      options: Record<string, unknown>,
    ) => {
      getJob(id: string): Promise<{ remove(): Promise<void> } | null>;
      close(): Promise<void>;
    };
  };
  const queue = new Queue("kiln-runs", { connection });
  try {
    await Promise.all(runIds.map(async (runId) => {
      const job = await queue.getJob(runId);
      await job?.remove().catch(() => undefined);
    }));
  } finally {
    await queue.close();
  }
}

export async function createOzJob(input: {
  userId: string;
  productUrl: string;
  mode: OzMode;
  userGoal?: string;
  preferredLanguage?: "node" | "python" | "go" | "curl";
  agentTargets?: AgentType[];
}): Promise<OzJob> {
  const oz = new OzOrchestrator({ store: getStore() });
  const job = await oz.createJob(input);
  startOzDiscovery(job.id);
  return job;
}

export function startOzDiscovery(jobId: string): void {
  const active = activeJobs();
  if (active.has(jobId)) return;
  active.add(jobId);
  void (async () => {
    try {
      const oz = new OzOrchestrator({ store: getStore() });
      const job = await oz.runToApproval(jobId);
      if (job.mode === "autopilot" && job.state.verification?.missingSecrets.length === 0) {
        await approveOzJob(job.id, job.userId);
        await runOzSuite(job.id, job.userId, {});
      }
    } catch (err) {
      console.error("Oz background discovery failed", err);
    } finally {
      active.delete(jobId);
    }
  })();
}

export async function requireOwnedOzJob(jobId: string, userId: string): Promise<OzJob> {
  const job = await getStore().getOzJob(jobId);
  if (!job || job.userId !== userId) throw new Error("Oz job not found");
  return job;
}

export async function refreshOwnedOzJob(jobId: string, userId: string): Promise<OzJob> {
  const job = await requireOwnedOzJob(jobId, userId);
  await maybeRefreshOzRunReport(job);
  const refreshed = await getStore().getOzJob(jobId);
  return refreshed ?? job;
}

export async function approveOzJob(jobId: string, userId: string): Promise<OzJob> {
  const job = await requireOwnedOzJob(jobId, userId);
  requireValidSuite(job.state.suiteDraft);
  if (job.status !== "awaiting_approval" && job.status !== "blocked") {
    throw new Error("Suite is not ready for approval.");
  }
  if (job.state.verification && !job.state.verification.schemaValid) {
    throw new Error("Suite schema must be valid before approval.");
  }
  const next: OzJob = {
    ...job,
    state: { ...job.state, approval: { status: "approved" } },
  };
  await getStore().saveOzJob(next);
  await getStore().appendOzEvent({
    jobId,
    kind: "approval.updated",
    phase: next.status,
    message: "User approved the generated suite.",
  });
  return next;
}

export async function editOzSuite(jobId: string, userId: string, suiteDraft: OzSuiteDraft): Promise<OzJob> {
  const job = await requireOwnedOzJob(jobId, userId);
  requireValidSuite(suiteDraft);
  const before = job.state.suiteDraft;
  const next: OzJob = {
    ...job,
    status: "awaiting_approval",
    state: {
      ...job.state,
      suiteDraft,
      verification: {
        schemaValid: true,
        runnable: true,
        missingSecrets: missingSecretsFor(job),
        weakAssertions: [],
        hallucinationRisks: job.state.verification?.hallucinationRisks ?? [],
        destructiveRisks: [],
      },
      approval: { status: "edited", userEdits: { editedAt: new Date().toISOString() } },
    },
  };
  await getStore().saveOzJob(next);
  await getStore().appendOzFeedback(jobId, "suite_edited", before, suiteDraft);
  await getStore().appendOzEvent({
    jobId,
    kind: "approval.updated",
    phase: next.status,
    message: "User edited Oz's generated suite.",
  });
  return next;
}

function scenarioVariant(scenario: OzScenario, action: string): OzScenario {
  if (action === "make_stricter") {
    return {
      ...scenario,
      assertions: [
        ...scenario.assertions,
        {
          type: "shell",
          name: "No placeholder implementation remains",
          config: { command: "! grep -R \"TODO\\|placeholder\\|mock result\" src README.md 2>/dev/null" },
        },
      ],
      confidence: Math.min(0.99, scenario.confidence + 0.04),
    };
  }
  if (action === "make_simpler") {
    return {
      ...scenario,
      task: `${scenario.task}\n\nKeep the implementation minimal and focus only on the first documented happy path.`,
      assertions: scenario.assertions.slice(0, Math.max(2, Math.min(3, scenario.assertions.length))),
      confidence: Math.max(0.55, scenario.confidence - 0.03),
    };
  }
  if (action === "add_negative_test") {
    return {
      ...scenario,
      assertions: [
        ...scenario.assertions,
        {
          type: "shell",
          name: "Negative credential path exists",
          config: { command: "grep -R \"invalid\\|missing\\|unauthorized\" src README.md 2>/dev/null" },
        },
      ],
    };
  }
  if (action === "add_webhook_test") {
    return {
      ...scenario,
      task: `${scenario.task}\n\nAlso include a webhook signature verification negative path if webhook docs exist.`,
      assertions: [
        ...scenario.assertions,
        {
          type: "shell",
          name: "Webhook signature check exists",
          config: { command: "grep -R \"signature\\|webhook\" src README.md 2>/dev/null" },
        },
      ],
    };
  }
  return {
    ...scenario,
    task: `${scenario.task}\n\nRegenerated by Oz at ${new Date().toISOString()}; keep every claim backed by discovered docs.`,
  };
}

export async function regenerateOzScenario(jobId: string, userId: string, scenarioId: string, action = "regenerate"): Promise<OzJob> {
  const job = await requireOwnedOzJob(jobId, userId);
  if (!job.state.suiteDraft) throw new Error("Suite is not ready.");
  const before = job.state.suiteDraft;
  const scenarios = before.scenarios.map((scenario) =>
    scenario.id === scenarioId ? scenarioVariant(scenario, action) : scenario,
  );
  const suiteDraft: OzSuiteDraft = {
    ...before,
    scenarios,
    assertions: scenarios.flatMap((scenario) => scenario.assertions),
    dynamicProbes: scenarios.flatMap((scenario) => scenario.dynamicProbes),
  };
  const next = await editOzSuite(jobId, userId, suiteDraft);
  await getStore().appendOzEvent({
    jobId,
    kind: "scenario.generated",
    phase: next.status,
    message: `Updated scenario with action: ${action.replaceAll("_", " ")}`,
    payload: { scenarioId, action },
  });
  return next;
}

export async function runOzSuite(
  jobId: string,
  userId: string,
  options: { scenarioId?: string; agentType?: AgentType; requestedRuns?: number },
): Promise<OzJob> {
  const job = await requireOwnedOzJob(jobId, userId);
  const suiteDraft = requireValidSuite(job.state.suiteDraft);
  if (job.state.approval?.status !== "approved" && job.mode !== "autopilot") {
    throw new Error("Suite must be approved before running.");
  }
  const scenarios = options.scenarioId
    ? suiteDraft.scenarios.filter((scenario) => scenario.id === options.scenarioId)
    : suiteDraft.scenarios;
  if (scenarios.length === 0) throw new Error("No scenarios selected.");

  const runIds: string[] = [];
  let evalId: string | undefined;
  for (const scenario of scenarios) {
    const evalConfig = scenarioToEvalConfig({
      state: job.state,
      scenario,
      agentType: options.agentType ?? job.state.input.agentTargets?.[0] ?? "claude-code",
      requestedRuns: options.requestedRuns ?? 1,
    });
    const evalRecord = await getStore().createEval(userId, evalConfig);
    evalId ??= evalRecord.id;
    const runs = await createRunsForEval(getStore(), evalRecord);
    for (const run of runs) {
      runIds.push(run.id);
      await enqueueRun(evalRecord, run);
    }
  }

  const next: OzJob = {
    ...job,
    status: "running",
    state: {
      ...job.state,
      run: {
        evalId,
        runIds,
        observedEventCount: 0,
      },
    },
  };
  await getStore().saveOzJob(next);
  await getStore().appendOzEvent({
    jobId,
    kind: "run.started",
    phase: "running",
    message: `Oz started ${runIds.length} run${runIds.length === 1 ? "" : "s"} across ${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"}.`,
    payload: { evalId, runIds },
  });
  return next;
}

export async function stopOzJob(jobId: string, userId: string): Promise<OzJob> {
  const job = await requireOwnedOzJob(jobId, userId);
  const runIds = job.state.run?.runIds ?? [];
  await removeQueuedRuns(runIds);
  await getStore().stopRuns(runIds, "Stopped by user before completion.");
  const next: OzJob = {
    ...job,
    status: "failed",
    state: {
      ...job.state,
      error: "Stopped by user before completion.",
      stoppedAt: new Date().toISOString(),
    },
  };
  activeJobs().delete(jobId);
  await getStore().saveOzJob(next);
  await getStore().appendOzEvent({
    jobId,
    kind: "job.failed",
    phase: "failed",
    message: "Stopped by user.",
    dedupeKey: `${jobId}:user-stop`,
    payload: { severity: "warning" },
  });
  return next;
}

export async function deleteOzJob(jobId: string, userId: string, options: { stopFirst?: boolean; deleteRunRecords?: boolean } = {}): Promise<void> {
  const job = await requireOwnedOzJob(jobId, userId);
  const runIds = job.state.run?.runIds ?? [];
  if (options.stopFirst) {
    await removeQueuedRuns(runIds);
    await getStore().stopRuns(runIds, "Terminated by user.");
    activeJobs().delete(jobId);
  }
  if (options.deleteRunRecords) {
    await getStore().deleteRuns(runIds, job.state.run?.evalId);
  }
  await getStore().deleteOzJob(jobId);
}

export async function maybeRefreshOzRunReport(job: OzJob): Promise<void> {
  const runIds = job.state.run?.runIds ?? [];
  if (runIds.length === 0) return;
  const runs = (await Promise.all(runIds.map((runId) => getStore().getRun(runId)))).filter((run) => run !== null);
  const liveCount = job.state.run?.observedEventCount ?? job.state.run?.liveEvents?.length ?? 0;
  const liveEvents = runs.flatMap((run) => run.events);
  for (const [offset, event] of liveEvents.slice(liveCount).entries()) {
    const index = liveCount + offset;
    await getStore().appendOzEvent(observeRunEvent(job.id, "running", event, `${job.id}:run-event:${index}`));
  }
  const done = runs.length === runIds.length && runs.every((run) => run.status === "completed" || run.status === "errored");
  if (!done) {
    if (liveEvents.length !== liveCount) {
      await getStore().saveOzJob({
        ...job,
        state: {
          ...job.state,
          run: {
            evalId: job.state.run?.evalId,
            runIds,
            observedEventCount: liveEvents.length,
          },
        },
      });
    }
    return;
  }
  if (job.status === "complete") return;
  const report = buildOzReport({ ...job.state, run: { evalId: job.state.run?.evalId, runIds, liveEvents } }, runs);
  const result = runs.map((run) => ({
    id: run.id,
    status: run.status,
    errorType: run.errorType,
    durationSec: run.durationSec,
    totalSteps: run.totalSteps,
    tokens: run.tokens,
    verdicts: run.verdicts.length,
  }));
  await getStore().saveOzJob({
    ...job,
    status: "complete",
    state: {
      ...job.state,
      run: {
        evalId: job.state.run?.evalId,
        runIds,
        observedEventCount: liveEvents.length,
        result,
      },
      report,
    },
  });
  await getStore().appendOzEvent({
    jobId: job.id,
    kind: "report.created",
    phase: "complete",
    message: report.summary,
    dedupeKey: `${job.id}:report`,
    payload: { report },
  });
}
