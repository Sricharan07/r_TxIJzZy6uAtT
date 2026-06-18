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

const successfulAgent: Agent = {
  type: "claude-code",
  async startTask(task) {
    if ("writeFile" in task.sandbox && typeof task.sandbox.writeFile === "function") {
      await task.sandbox.writeFile("src/checkout.ts", "export const checkout = true;\n");
      await task.sandbox.writeFile("README.md", "This project contains a checkout scaffold.\n");
    }
    return {
      events: [
        { t: 1, kind: "file", text: "Created src/checkout.ts" },
        { t: 2, kind: "file", text: "Created README.md" },
      ],
      tokens: 100,
      steps: 2,
      async collectArtifacts() {},
    };
  },
};

describe("executeRun", () => {
  it("runs an eval and returns a reportable result", async () => {
    const streamed: string[] = [];
    const result = await executeRun(config, {
      runId: "run_test",
      evalId: "eval_test",
      evalTitle: "Checkout Eval",
      sandbox: new LocalSandbox("run-test"),
      agent: successfulAgent,
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
    expect(result.verdicts.every((v) => v.evidence?.length === 1)).toBe(true);
    expect(result.verdicts.filter((v) => v.type !== "llm").every((v) => v.passed)).toBe(true);
    expect(result.gradeReport).toMatchObject({
      taskPassed: true,
      score: { letter: "A+", runs: 1, passedRuns: 1 },
    });
    expect(result.gradeReport?.findings.every((finding) => finding.status === "advisory")).toBe(true);
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
    const result = await executeRun(config, {
      sandbox: new BrokenSandbox("grader-platform-test"),
      agent: successfulAgent,
    });

    expect(result.status).toBe("errored");
    expect(result.errorType).toBe("platform");
    expect(result.events.at(-1)?.annotation).toContain("sandbox manager unavailable");
  });

  it("runs product setup, preflight, assertion env, and cleanup steps", async () => {
    const previous = process.env.KILN_PRODUCT_TOKEN;
    process.env.KILN_PRODUCT_TOKEN = "runner-test-token";
    try {
      const result = await executeRun(
        {
          ...config,
          productProfile: {
            companyName: "TestCo",
            productName: "Test SDK",
            productType: "sdk",
            runtime: { language: "node", image: "default" },
            docsSources: [{ type: "paste", label: "Product docs", content: "Use the official SDK." }],
            requiredEnv: [
              { name: "KILN_PRODUCT_TOKEN", scopes: ["setup", "assertion", "cleanup"], required: true },
            ],
            setupSteps: [
              {
                name: "Write setup marker",
                command: "node -e \"require('node:fs').writeFileSync('setup-token.txt', process.env.KILN_PRODUCT_TOKEN)\"",
              },
            ],
            preflightChecks: [{ name: "Setup marker exists", command: "test -f setup-token.txt" }],
            cleanupSteps: [{ name: "Cleanup marker", command: "echo cleaned > cleanup.txt" }],
          },
          assertions: [
            ...config.assertions,
            {
              type: "shell",
              name: "Assertion has scoped product env",
              config: { command: "test \"$KILN_PRODUCT_TOKEN\" = \"runner-test-token\"" },
            },
          ],
        },
        {
          sandbox: new LocalSandbox("product-steps-test"),
          agent: successfulAgent,
        },
      );

      expect(result.status).toBe("completed");
      expect(result.verdicts.filter((verdict) => verdict.type !== "llm").every((verdict) => verdict.passed)).toBe(true);
      expect(result.events.map((event) => event.text)).toEqual(
        expect.arrayContaining([
          "Product setup: Write setup marker",
          "Product preflight: Setup marker exists",
          "Product cleanup: Cleanup marker",
        ]),
      );
    } finally {
      if (previous === undefined) delete process.env.KILN_PRODUCT_TOKEN;
      else process.env.KILN_PRODUCT_TOKEN = previous;
    }
  });

  it("redacts product environment values from streamed and stored run events", async () => {
    const previous = process.env.KILN_PRODUCT_TOKEN;
    process.env.KILN_PRODUCT_TOKEN = "runner-secret-token";
    const leakingAgent: Agent = {
      type: "claude-code",
      async startTask(task) {
        await task.onEvent?.({
          t: 1,
          kind: "info",
          text: "Calling product API with runner-secret-token",
          annotation: "debug header runner-secret-token",
        });
        if ("writeFile" in task.sandbox && typeof task.sandbox.writeFile === "function") {
          await task.sandbox.writeFile("src/checkout.ts", "export const checkout = true;\n");
          await task.sandbox.writeFile("README.md", "This project contains a checkout scaffold.\n");
        }
        return {
          events: [],
          tokens: 100,
          steps: 1,
          async collectArtifacts() {},
        };
      },
    };
    const streamed: string[] = [];
    try {
      const result = await executeRun(
        {
          ...config,
          productProfile: {
            companyName: "TestCo",
            productName: "Secret API",
            productType: "api",
            runtime: { language: "node", image: "default" },
            docsSources: [],
            requiredEnv: [{ name: "KILN_PRODUCT_TOKEN", scopes: ["agent", "assertion"], required: true }],
          },
          assertions: [
            ...config.assertions,
            {
              type: "shell",
              name: "Assertion output is redacted",
              config: { command: "node -e \"process.stdout.write(process.env.KILN_PRODUCT_TOKEN || '')\"" },
            },
          ],
        },
        {
          sandbox: new LocalSandbox("redacted-product-env-test"),
          agent: leakingAgent,
          async onEvent(event) {
            streamed.push(`${event.text} ${event.annotation ?? ""}`);
          },
        },
      );

      const stored = result.events.map((event) => `${event.text} ${event.annotation ?? ""}`).join("\n");
      const verdicts = JSON.stringify(result.verdicts);
      expect(streamed.join("\n")).not.toContain("runner-secret-token");
      expect(stored).not.toContain("runner-secret-token");
      expect(verdicts).not.toContain("runner-secret-token");
      expect(streamed.join("\n")).toContain("[redacted:KILN_PRODUCT_TOKEN]");
      expect(stored).toContain("[redacted:KILN_PRODUCT_TOKEN]");
      expect(verdicts).toContain("[redacted:KILN_PRODUCT_TOKEN]");
    } finally {
      if (previous === undefined) delete process.env.KILN_PRODUCT_TOKEN;
      else process.env.KILN_PRODUCT_TOKEN = previous;
    }
  });

  it("uses eval-scoped product env overlays for setup, agent commands, assertions, and cleanup", async () => {
    const previous = process.env.KILN_PRODUCT_TOKEN;
    delete process.env.KILN_PRODUCT_TOKEN;
    const envCheckingAgent: Agent = {
      type: "claude-code",
      async startTask(task) {
        const check = await task.sandbox.exec("test \"$KILN_PRODUCT_TOKEN\" = \"overlay-secret\" && mkdir -p src && echo ok > src/agent-env.txt");
        if (check.code !== 0) throw new Error(check.stderr || check.stdout || "agent env check failed");
        return {
          events: [{ t: 1, kind: "command", text: "Verified product env inside agent" }],
          tokens: 50,
          steps: 1,
          async collectArtifacts() {},
        };
      },
    };
    try {
      const result = await executeRun(
        {
          ...config,
          productProfile: {
            companyName: "TestCo",
            productName: "Overlay API",
            productType: "api",
            runtime: { language: "node", image: "default" },
            docsSources: [],
            requiredEnv: [
              { name: "KILN_PRODUCT_TOKEN", scopes: ["setup", "agent", "assertion", "cleanup"], required: true },
            ],
            setupSteps: [{ name: "Setup receives overlay secret", command: "test \"$KILN_PRODUCT_TOKEN\" = \"overlay-secret\"" }],
            cleanupSteps: [{ name: "Cleanup receives overlay secret", command: "test \"$KILN_PRODUCT_TOKEN\" = \"overlay-secret\"" }],
          },
          assertions: [
            {
              type: "file",
              name: "Agent wrote file after env check",
              config: { path: "src/agent-env.txt", contains: "ok" },
            },
            {
              type: "shell",
              name: "Assertion receives overlay secret",
              config: { command: "test \"$KILN_PRODUCT_TOKEN\" = \"overlay-secret\"" },
            },
          ],
        },
        {
          sandbox: new LocalSandbox("product-env-overlay-test"),
          agent: envCheckingAgent,
          productEnv: { KILN_PRODUCT_TOKEN: "overlay-secret" },
        },
      );

      expect(result.status).toBe("completed");
      expect(result.verdicts[0]?.passed).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.KILN_PRODUCT_TOKEN;
      else process.env.KILN_PRODUCT_TOKEN = previous;
    }
  });

  it("fails fast when a required product environment variable is missing", async () => {
    const result = await executeRun(
      {
        ...config,
        productProfile: {
          companyName: "TestCo",
          productName: "Missing Env Product",
          productType: "api",
          runtime: { language: "node", image: "default" },
          docsSources: [],
          requiredEnv: [{ name: "KILN_MISSING_PRODUCT_TOKEN", scopes: ["agent"], required: true }],
        },
      },
      { sandbox: new LocalSandbox("missing-product-env-test"), agent: successfulAgent },
    );

    expect(result.status).toBe("errored");
    expect(result.errorType).toBe("platform");
    expect(result.events.at(-1)?.annotation).toContain("KILN_MISSING_PRODUCT_TOKEN");
  });
});
