import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { BlobStore } from "./s3";
import type { EvalConfig, RunResult } from "./types";
import { JsonKilnStore, getStore } from "./store";
import { PostgresKilnStore } from "./postgres-store";

const config: EvalConfig = {
  task: "Build a checkout flow",
  language: "node",
  context: [{ type: "paste", label: "Docs", content: "Use src/checkout.ts" }],
  assertions: [{ type: "file", name: "checkout file", config: { path: "src/checkout.ts" } }],
  metadata: { agentType: "claude-code", timeoutSec: 300 },
};

describe("JsonKilnStore", () => {
  it("persists eval configs and runs by id/share token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kiln-store-test-"));
    try {
      const store = new JsonKilnStore(join(dir, "data.json"));
      const user = await store.getOrCreateDevUser();
      const evalRecord = await store.createEval(user.id, config);
      const run = await store.createRun(evalRecord);
      await store.saveRun({ ...run, status: "completed" });

      const reloaded = new JsonKilnStore(join(dir, "data.json"));
      expect(await reloaded.getEval(evalRecord.id)).toMatchObject({ id: evalRecord.id });
      expect(await reloaded.getEval(evalRecord.shareToken)).toMatchObject({ id: evalRecord.id });
      expect(await reloaded.getRun(run.id)).toMatchObject({ status: "completed" });
      expect(await reloaded.listEvals(user.id)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: evalRecord.id, runCount: 1 })]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("selects Postgres only when DATABASE_URL is configured", () => {
    const databaseUrl = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      expect(getStore()).toBeInstanceOf(JsonKilnStore);
      process.env.DATABASE_URL = "postgres://kiln:kiln@localhost:5432/kiln";
      expect(getStore()).toBeInstanceOf(PostgresKilnStore);
    } finally {
      if (databaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = databaseUrl;
      getStore();
    }
  });
});

describe("PostgresKilnStore", () => {
  it("writes traces to blob storage and metadata/verdicts to Postgres", async () => {
    const sql: string[] = [];
    const traces: Record<string, unknown> = {};
    const blobs: BlobStore = {
      async putTrace(runId, events) {
        traces[runId] = events;
        return `traces/${runId}.json`;
      },
      async getTrace() {
        return null;
      },
      async putAsset(key) {
        return key;
      },
    };
    const pool = {
      async connect() {
        return {
          async query(text: string) {
            sql.push(text);
            return { rows: [] };
          },
          release() {},
        };
      },
    } as unknown as Pool;
    const store = new PostgresKilnStore("postgres://unused", blobs, pool, false);
    const run: RunResult = {
      id: "2648744e-91ec-49b9-ad8d-28cf7f315c1d",
      evalId: "aa11dff0-b85b-4d52-9777-37fa91bc857f",
      evalTitle: "Checkout",
      task: "Build checkout",
      agentType: "claude-code",
      status: "completed",
      errorType: null,
      startedAt: "2026-06-01T00:00:00.000Z",
      finishedAt: "2026-06-01T00:00:08.000Z",
      durationSec: 8,
      totalSteps: 1,
      tokens: 10,
      events: [{ t: 8, kind: "file", text: "Created checkout.ts" }],
      verdicts: [{ assertionIndex: 0, type: "file", name: "checkout exists", passed: true }],
    };

    await store.saveRun(run);

    expect(traces[run.id]).toEqual(run.events);
    expect(sql.some((text) => text.includes("UPDATE runs"))).toBe(true);
    expect(sql.some((text) => text.includes("INSERT INTO verdicts"))).toBe(true);
  });
});
