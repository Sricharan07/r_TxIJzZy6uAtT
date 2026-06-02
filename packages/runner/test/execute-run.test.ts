import { describe, it, expect } from "vitest";
import { executeRun } from "../src/index";
import type { EvalConfig } from "@kiln/shared";

const config: EvalConfig = {
  task: "Build a checkout flow using the Acme Payments SDK and handle the webhook.",
  language: "node",
  context: [
    { type: "url", label: "https://docs.acme.dev/quickstart", crawlDepth: "single" },
    { type: "file", label: "example.ts", content: "// example" },
  ],
  assertions: [
    { type: "file", name: "index created", config: { path: "src/index.ts" } },
    { type: "file", name: "checkout created", config: { path: "src/checkout.ts" } },
    { type: "shell", name: "tests pass", config: { command: "node test.js" } },
    { type: "http", name: "health up", config: { url: "http://localhost:3000/health" } },
    { type: "llm", name: "follows patterns", config: { criterion: "follows SDK patterns" } },
  ],
  metadata: { agentType: "claude-code", timeoutSec: 300 },
};

describe("executeRun (full pipeline)", () => {
  it("runs the agent in a sandbox, grades it, and assembles a RunResult", async () => {
    const run = await executeRun(config);

    expect(run.status).toBe("completed");
    expect(run.errorType).toBeNull();

    // One verdict per assertion, aligned by type/order.
    expect(run.verdicts).toHaveLength(config.assertions.length);
    expect(run.verdicts.map((v) => v.type)).toEqual(["file", "file", "shell", "http", "llm"]);

    const byName = Object.fromEntries(run.verdicts.map((v) => [v.name, v.passed]));
    // The simulated agent writes src/index.ts + test.js, but not src/checkout.ts,
    // and starts no server — so these outcomes are deterministic.
    expect(byName["index created"]).toBe(true);
    expect(byName["checkout created"]).toBe(false);
    expect(byName["tests pass"]).toBe(true);
    expect(byName["health up"]).toBe(false);

    expect(run.events.length).toBeGreaterThan(0);
    expect(run.totalSteps).toBeGreaterThan(0);
  });

  it("gives re-runs distinct ids but the same evalId (Decision 17)", async () => {
    const first = await executeRun(config);
    const second = await executeRun(config, { attempt: 1 });
    expect(first.id).not.toBe(second.id);
    expect(first.evalId).toBe(second.evalId);
  });
});
