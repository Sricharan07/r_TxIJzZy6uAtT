import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OzAgentState, OzProductProfile, OzScenario, OzSuiteDraft } from "@kiln/shared";

const state = vi.hoisted(() => ({
  store: null as import("@kiln/shared/store").JsonKilnStore | null,
  health: vi.fn(),
}));

vi.mock("@kiln/shared/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kiln/shared/store")>();
  return {
    ...actual,
    getStore: () => state.store,
  };
});

vi.mock("./system-health", () => ({
  getRunInfrastructureHealth: state.health,
}));

import { scenarioToEvalConfig } from "@kiln/oz-agent";
import { JsonKilnStore } from "@kiln/shared/store";
import { OzRunBlockedError, refreshOwnedOzJob, runOzSuite, stopOzJob } from "./oz";

function scenario(requiredEnv: OzProductProfile["requiredEnv"]): OzScenario {
  return {
    id: "first_call",
    title: "First call",
    rationale: "Exercise a documented integration path.",
    task: "Build a minimal integration.",
    assertions: [
      { type: "file", name: "Entrypoint exists", config: { path: "src/index.ts" } },
      { type: "shell", name: "Build succeeds", config: { command: "npm test || npm run build" } },
    ],
    dynamicProbes: [],
    requiredEnv,
    setupSteps: [],
    cleanupSteps: [],
    confidence: 0.8,
    sources: [{ source: "test", quote: "test docs", confidence: 0.8 }],
    risks: [],
  };
}

async function createReadyJob(requiredEnv: OzProductProfile["requiredEnv"] = []) {
  const store = state.store!;
  const user = await store.getOrCreateDevUser();
  const productProfile: OzProductProfile = {
    companyName: "Acme",
    productName: "Acme",
    productType: ["api"],
    summary: "Acme exposes an API.",
    sdks: [],
    APIs: [],
    webhooks: [],
    requiredEnv,
    confidence: 0.8,
    evidence: [{ source: "test", quote: "test docs", confidence: 0.8 }],
  };
  const testScenario = scenario(requiredEnv);
  const suiteDraft: OzSuiteDraft = {
    scenarios: [testScenario],
    globalSetup: [],
    globalEnv: requiredEnv,
    assertions: testScenario.assertions,
    dynamicProbes: [],
    confidence: 0.8,
    risks: [],
  };
  const agentState: OzAgentState = {
    jobId: crypto.randomUUID(),
    userId: user.id,
    input: { productUrl: "https://acme.test/docs", mode: "copilot" },
    discovery: { docsCandidates: [], selectedDocs: [], githubRepos: [], packages: [], codeExamples: [] },
    productProfile,
    suiteDraft,
    verification: {
      schemaValid: true,
      runnable: true,
      missingSecrets: requiredEnv.map((env) => env.name),
      weakAssertions: [],
      hallucinationRisks: [],
      destructiveRisks: [],
    },
    approval: { status: "pending" },
  };
  const job = await store.createOzJob(user.id, agentState.input.productUrl, "copilot", agentState);
  await store.saveOzJob({ ...job, status: "awaiting_approval", state: agentState });
  return { user, job: (await store.getOzJob(job.id))!, scenario: testScenario };
}

describe("Oz run lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    state.store = new JsonKilnStore(`/tmp/kiln-oz-web-${crypto.randomUUID()}.json`);
    state.health.mockResolvedValue({ ok: true, checks: [], blockers: [] });
  });

  it("blocks manual runs when required product secrets are missing", async () => {
    const { user, job } = await createReadyJob([
      { name: "KILN_MISSING_PRODUCT_TOKEN", scopes: ["agent"], required: true },
    ]);

    await expect(runOzSuite(job.id, user.id, {})).rejects.toMatchObject({
      missingSecrets: ["KILN_MISSING_PRODUCT_TOKEN"],
    });
    await expect(runOzSuite(job.id, user.id, {})).rejects.toBeInstanceOf(OzRunBlockedError);
    expect((await state.store!.getOzJob(job.id))?.state.approval?.status).toBe("pending");
  });

  it("blocks runs when runner infrastructure is unhealthy", async () => {
    vi.stubEnv("KILN_PRESENT_PRODUCT_TOKEN", "present");
    state.health.mockResolvedValue({
      ok: false,
      checks: [],
      blockers: ["runner: No live runner heartbeat is available."],
    });
    const { user, job } = await createReadyJob([
      { name: "KILN_PRESENT_PRODUCT_TOKEN", scopes: ["agent"], required: true },
    ]);

    await expect(runOzSuite(job.id, user.id, {})).rejects.toMatchObject({
      blockers: ["runner: No live runner heartbeat is available."],
    });
  });

  it("stops Oz jobs without creating a product report", async () => {
    const { user, job, scenario: testScenario } = await createReadyJob();
    const evalRecord = await state.store!.createEval(user.id, scenarioToEvalConfig({
      state: job.state,
      scenario: testScenario,
      agentType: "claude-code",
      requestedRuns: 1,
    }));
    const run = await state.store!.createRun(evalRecord);
    await state.store!.saveOzJob({
      ...job,
      status: "running",
      state: { ...job.state, approval: { status: "approved" }, run: { evalId: evalRecord.id, runIds: [run.id] } },
    });

    const stopped = await stopOzJob(job.id, user.id);
    const stoppedRun = await state.store!.getRun(run.id);
    const refreshed = await refreshOwnedOzJob(job.id, user.id);

    expect(stopped.status).toBe("stopped");
    expect(stoppedRun?.status).toBe("canceled");
    expect(refreshed.status).toBe("stopped");
    expect(refreshed.state.report).toBeUndefined();
  });
});
