import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Eval, EvalConfig, RunResult } from "@kiln/shared";

const state = vi.hoisted(() => ({
  currentUserId: vi.fn(),
  store: {
    getEval: vi.fn(),
    listRuns: vi.fn(),
    createEval: vi.fn(),
    upsertProductSecrets: vi.fn(),
  },
  jobs: {
    createRunsForEval: vi.fn(),
    enqueueRun: vi.fn(),
  },
}));

vi.mock("@kiln/shared/store", () => ({
  getStore: () => state.store,
}));

vi.mock("../lib/auth", () => ({
  currentUserId: state.currentUserId,
}));

vi.mock("../lib/jobs", () => ({
  createRunsForEval: state.jobs.createRunsForEval,
  enqueueRun: state.jobs.enqueueRun,
}));

import { GET } from "../app/api/evals/[id]/route";
import { POST } from "../app/api/evals/route";

const config: EvalConfig = {
  task: "Create a checkout integration",
  language: "node",
  context: [{ type: "paste", label: "API docs", content: "Use the official SDK." }],
  assertions: [{ type: "file", name: "creates checkout file", config: { path: "src/checkout.ts" } }],
  metadata: { agentType: "claude-code", timeoutSec: 60, requestedRuns: 1 },
};

const evalRecord: Eval = {
  id: "eval-1",
  userId: "owner-1",
  shareToken: "cfg-share-token",
  config,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const run: RunResult = {
  id: "run-1",
  evalId: evalRecord.id,
  evalTitle: "Create a checkout integration",
  task: config.task,
  agentType: "claude-code",
  status: "completed",
  errorType: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:10.000Z",
  durationSec: 10,
  totalSteps: 2,
  tokens: 100,
  events: [],
  verdicts: [],
};

async function requestEval(id: string): Promise<{ status: number; body: unknown }> {
  const response = await GET(new Request(`http://test.local/api/evals/${id}`), {
    params: Promise.resolve({ id }),
  });
  return { status: response.status, body: await response.json() };
}

describe("eval detail API authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.store.getEval.mockResolvedValue(evalRecord);
    state.store.listRuns.mockResolvedValue([run]);
  });

  it("allows the owner to load an eval by id", async () => {
    state.currentUserId.mockResolvedValue("owner-1");

    const { status, body } = await requestEval("eval-1");

    expect(status).toBe(200);
    expect(body).toMatchObject({ eval: { id: "eval-1" }, runs: [{ id: "run-1" }] });
    expect(state.store.listRuns).toHaveBeenCalledWith("eval-1");
  });

  it("returns 404 instead of leaking private eval existence to another user", async () => {
    state.currentUserId.mockResolvedValue("other-user");

    const { status, body } = await requestEval("eval-1");

    expect(status).toBe(404);
    expect(body).toEqual({ error: "Eval not found" });
    expect(state.store.listRuns).not.toHaveBeenCalled();
  });

  it("requires sign-in for a private eval id when no session is present", async () => {
    state.currentUserId.mockResolvedValue(null);

    const { status, body } = await requestEval("eval-1");

    expect(status).toBe(401);
    expect(body).toEqual({ error: "GitHub sign-in required" });
    expect(state.store.listRuns).not.toHaveBeenCalled();
  });

  it("allows public access through the eval share token", async () => {
    state.currentUserId.mockResolvedValue(null);

    const { status, body } = await requestEval("cfg-share-token");

    expect(status).toBe(200);
    expect(body).toMatchObject({ eval: { id: "eval-1", shareToken: "cfg-share-token" } });
    expect(state.store.listRuns).toHaveBeenCalledWith("eval-1");
  });
});

describe("eval creation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentUserId.mockResolvedValue("owner-1");
    state.store.createEval.mockImplementation(async (userId: string, input: EvalConfig) => ({
      id: "eval-created",
      userId,
      shareToken: "cfg-created",
      config: input,
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    state.store.upsertProductSecrets.mockResolvedValue([]);
    state.jobs.createRunsForEval.mockResolvedValue([
      { ...run, id: "run-created", evalId: "eval-created", status: "pending" },
    ]);
    state.jobs.enqueueRun.mockResolvedValue(undefined);
  });

  it("stores manual product secrets separately from eval config", async () => {
    const configWithSecret = {
      ...config,
      productProfile: {
        companyName: "ExampleCo",
        productName: "Example API",
        productType: "api",
        runtime: { language: "node" },
        docsSources: [{ type: "url", label: "Docs", content: "https://example.test/docs", crawlDepth: "single" }],
        requiredEnv: [{ name: "EXAMPLE_API_KEY", scopes: ["agent", "assertion"], required: true }],
      },
      productSecrets: {
        EXAMPLE_API_KEY: "secret-value",
      },
    };

    const response = await POST(new Request("http://test.local/api/evals", {
      method: "POST",
      body: JSON.stringify(configWithSecret),
    }));

    expect(response.status).toBe(201);
    expect(state.store.createEval).toHaveBeenCalledTimes(1);
    const [, storedConfig] = state.store.createEval.mock.calls[0]!;
    expect(storedConfig).not.toHaveProperty("productSecrets");
    expect(JSON.stringify(storedConfig)).not.toContain("secret-value");
    expect(state.store.upsertProductSecrets).toHaveBeenCalledWith({
      userId: "owner-1",
      scopeType: "eval",
      scopeId: "eval-created",
      values: { EXAMPLE_API_KEY: "secret-value" },
    });
  });
});
