import { describe, expect, it } from "vitest";
import type { EvalConfig } from "@kiln/shared";
import { executeRun } from "./worker";
import { LocalSandbox } from "./sandbox/firecracker";
import type { Agent } from "./agents/interface";

const config: EvalConfig = {
  task: "Build a checkout flow using the Acme Payments SDK.",
  language: "node",
  context: [{ type: "paste", label: "SDK docs", content: "Create src/checkout.ts" }],
  assertions: [
    { type: "file", name: "Checkout file exists", config: { path: "src/checkout.ts" } },
    { type: "shell", name: "Checkout file visible to shell", config: { command: "test -f src/checkout.ts" } },
    { type: "llm", name: "README describes task", config: { criterion: "checkout scaffold" } },
  ],
  metadata: { agentType: "claude-code", timeoutSec: 300 },
};

describe("executeRun", () => {
  it("runs an eval and returns a reportable result", async () => {
    const streamed: string[] = [];
    const result = await executeRun(config, {
      runId: "run_test",
      evalId: "eval_test",
      evalTitle: "Checkout Eval",
      async onEvent(event) {
        streamed.push(event.text);
      },
    });

    expect(result.id).toBe("run_test");
    expect(result.evalId).toBe("eval_test");
    expect(result.status).toBe("completed");
    expect(result.events.length).toBeGreaterThan(0);
    expect(streamed.length).toBe(result.events.length);
    expect(result.verdicts).toHaveLength(config.assertions.length);
    expect(result.verdicts.every((v) => v.passed)).toBe(true);
  });

  it("classifies a hard sandbox timeout separately from platform errors", async () => {
    const hangingAgent: Agent = {
      type: "claude-code",
      async startTask() {
        return new Promise(() => {});
      },
    };
    const result = await executeRun(
      { ...config, metadata: { ...config.metadata, timeoutSec: 0.001 } },
      { sandbox: new LocalSandbox("timeout-test"), agent: hangingAgent },
    );

    expect(result.status).toBe("errored");
    expect(result.errorType).toBe("timeout");
    expect(result.events[0]?.annotation).toContain("timeout");
  });

  it("classifies grader transport failures as platform errors", async () => {
    class BrokenSandbox extends LocalSandbox {
      override async readFile(): Promise<string | null> {
        throw new Error("sandbox manager unavailable");
      }
    }
    const result = await executeRun(config, { sandbox: new BrokenSandbox("grader-platform-test") });

    expect(result.status).toBe("errored");
    expect(result.errorType).toBe("platform");
    expect(result.events.at(-1)?.annotation).toContain("sandbox manager unavailable");
  });
});
