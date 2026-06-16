import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Eval, EvalConfig, RunResult } from "@kiln/shared";

const state = vi.hoisted(() => ({
  currentUserId: vi.fn(),
  store: {
    getEval: vi.fn(),
    listRuns: vi.fn(),
  },
}));

vi.mock("@kiln/shared/store", () => ({
  getStore: () => state.store,
}));

vi.mock("../lib/auth", () => ({
  currentUserId: state.currentUserId,
}));

import { GET } from "../app/api/evals/[id]/route";

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
