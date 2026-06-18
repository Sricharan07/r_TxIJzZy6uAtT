import { describe, expect, it } from "vitest";
import { aggregateCompletedRunReports, type Assertion, type EvalConfig, type GradeReport } from "@kiln/shared";
import { grade, gradeWithReport } from "./grader";
import type { SandboxHandle, ExecResult, HttpRequest, HttpResult } from "./sandbox";
import { AnthropicJudge } from "./assertions/llm-judge";

class FakeSandbox implements SandboxHandle {
  async exec(cmd: string): Promise<ExecResult> {
    return cmd === "npm test"
      ? { stdout: "ok\n", stderr: "", code: 0 }
      : { stdout: "", stderr: "missing\n", code: 1 };
  }

  async readFile(path: string): Promise<string | null> {
    return path === "src/index.ts" ? "export const ok = true;" : null;
  }

  async httpGet(url: string): Promise<HttpResult> {
    return this.httpRequest({ url });
  }

  async httpRequest(request: HttpRequest): Promise<HttpResult> {
    const url = request.url;
    return url.endsWith("/health")
      ? { status: 200, body: "healthy" }
      : { status: 404, body: "not found" };
  }
}

class ProjectSandbox implements SandboxHandle {
  constructor(
    private readonly files: Record<string, string>,
    private readonly responses: Record<string, HttpResult> = {},
  ) {}

  async exec(cmd: string): Promise<ExecResult> {
    if (cmd.startsWith("find ")) {
      return {
        stdout: Object.keys(this.files)
          .map((path) => `./${path}`)
          .join("\n"),
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "ok\n", stderr: "", code: 0 };
  }

  async readFile(path: string): Promise<string | null> {
    return this.files[path] ?? null;
  }

  async httpGet(url: string): Promise<HttpResult> {
    return this.httpRequest({ url });
  }

  async httpRequest(request: HttpRequest): Promise<HttpResult> {
    const key = `${request.method ?? "GET"} ${request.url}`;
    return this.responses[key] ?? { status: 404, body: "not found" };
  }
}

function staticConfig(task: string, context = ""): EvalConfig {
  return {
    task,
    language: "node",
    context: [{ type: "paste", label: "Docs", content: context }],
    assertions: [{ type: "file", name: "entry exists", config: { path: "src/index.ts" } }],
    metadata: { agentType: "claude-code", timeoutSec: 300, modelId: "test-model" },
  };
}

function productProfile(packages: NonNullable<EvalConfig["productProfile"]>["packages"] = []): NonNullable<EvalConfig["productProfile"]> {
  return {
    companyName: "Acme",
    productName: "Acme",
    productType: "other",
    runtime: { language: "node" },
    docsSources: [],
    packages,
  };
}

function findingCodes(report: GradeReport): string[] {
  return report.findings.map((finding) => finding.code);
}

describe("grade", () => {
  it("runs shell, http, file, and llm assertions independently", async () => {
    const assertions: Assertion[] = [
      { type: "shell", name: "test command", config: { command: "npm test" } },
      { type: "http", name: "health", config: { url: "http://localhost/health" } },
      { type: "file", name: "source exists", config: { path: "src/index.ts", contains: "ok" } },
      { type: "llm", name: "mentions ok", config: { criterion: "README explains ok behavior" } },
      { type: "file", name: "missing file", config: { path: "missing.ts" } },
    ];

    const verdicts = await grade(assertions, new FakeSandbox());

    expect(verdicts).toHaveLength(5);
    expect(verdicts.slice(0, 3).every((v) => v.passed)).toBe(true);
    expect(verdicts.every((v) => v.evidence?.length === 1)).toBe(true);
    expect(verdicts[3]?.type).toBe("llm");
    expect(verdicts[4]?.passed).toBe(false);
    expect(verdicts[4]?.hint).toContain("does not exist");
    expect(verdicts[4]?.evidence?.[0]?.replayCmd).toBe("test -f 'missing.ts'");
  });

  it("propagates sandbox transport failures for platform classification", async () => {
    class BrokenSandbox extends FakeSandbox {
      override async readFile(): Promise<string | null> {
        throw new Error("sandbox manager unavailable");
      }
    }

    await expect(
      grade([{ type: "file", name: "source exists", config: { path: "src/index.ts" } }], new BrokenSandbox()),
    ).rejects.toThrow("sandbox manager unavailable");
  });

  it("returns a structured grade report with confirmed deterministic findings", async () => {
    const config: EvalConfig = {
      task: "Create the missing source file.",
      language: "node",
      context: [],
      assertions: [
        {
          type: "file",
          name: "source exists",
          config: { path: "missing.ts" },
          severityOnFail: "critical",
        },
      ],
      metadata: { agentType: "claude-code", timeoutSec: 300, modelId: "test-model" },
    };

    const result = await gradeWithReport(config, new FakeSandbox(), {
      runId: "run_report",
      generatedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(result.verdicts[0]?.evidence?.[0]?.replayCmd).toBe("test -f 'missing.ts'");
    expect(result.gradeReport.score.letter).toBe("F");
    expect(result.gradeReport.score.cap).toMatchObject({ maxGrade: "C-" });
    expect(result.gradeReport.taskPassed).toBe(false);
    expect(result.gradeReport.findings).toEqual([
      expect.objectContaining({
        status: "confirmed",
        severity: "critical",
        code: "expected_artifact_missing",
        evidence: [expect.objectContaining({ type: "deterministic", confidence: 1 })],
      }),
    ]);
  });

  it("keeps LLM judge failures advisory in slice 1", async () => {
    const config: EvalConfig = {
      task: "Document the project.",
      language: "node",
      context: [],
      assertions: [
        { type: "llm", name: "README is clear", config: { criterion: "clear README" } },
      ],
      metadata: { agentType: "claude-code", timeoutSec: 300 },
    };

    const result = await gradeWithReport(config, new FakeSandbox(), {
      runId: "run_advisory",
      generatedAt: "2026-06-01T00:00:00.000Z",
      judge: {
        async judge() {
          return { passed: false, reasoning: "README does not explain the behavior." };
        },
      },
    });

    expect(result.gradeReport.taskPassed).toBe(true);
    expect(result.gradeReport.score.letter).toBe("A+");
    expect(result.gradeReport.findings).toEqual([
      expect.objectContaining({
        status: "advisory",
        severity: "medium",
        canHardCap: false,
      }),
    ]);
  });

  it("does not fail the task for non-required deterministic advisory assertions", async () => {
    class AdvisorySandbox extends ProjectSandbox {
      override async exec(cmd: string): Promise<ExecResult> {
        if (cmd === "missing-check") return { stdout: "", stderr: "surface not referenced\n", code: 1 };
        return super.exec(cmd);
      }
    }

    const config: EvalConfig = {
      task: "Create the integration entrypoint.",
      language: "node",
      context: [],
      assertions: [
        { type: "file", name: "entry exists", config: { path: "src/index.ts" } },
        {
          type: "shell",
          name: "advisory documented surface",
          config: { command: "missing-check" },
          required: false,
          severityOnFail: "low",
          frictionCode: "documented_surface_not_referenced",
          canHardCap: false,
          codeVsNoCode: "mixed",
        },
      ],
      metadata: { agentType: "claude-code", timeoutSec: 300, modelId: "test-model" },
    };

    const result = await gradeWithReport(
      config,
      new AdvisorySandbox({ "src/index.ts": "export const ok = true;" }),
      { runId: "run_advisory_static", generatedAt: "2026-06-01T00:00:00.000Z" },
    );

    expect(result.gradeReport.taskPassed).toBe(true);
    expect(result.gradeReport.score.letter).toBe("A+");
    expect(result.gradeReport.findings).toEqual([
      expect.objectContaining({
        status: "advisory",
        severity: "low",
        code: "documented_surface_not_referenced",
        canHardCap: false,
      }),
    ]);
  });

  it("does not emit static findings for a clean generated integration", async () => {
    const result = await gradeWithReport(
      staticConfig(
        "Build a checkout flow, create a payment intent, and register a webhook.",
        [
          "npm install acme-payments-sdk",
          "Use Authorization: Bearer <token>.",
          "Verify webhook signatures.",
          "Use idempotency keys for payment creation.",
        ].join("\n"),
      ),
      new ProjectSandbox({
        "package.json": JSON.stringify({ dependencies: { "acme-payments-sdk": "1.0.0" } }),
        "src/index.ts": [
          'import { AcmeClient } from "acme-payments-sdk";',
          "const client = new AcmeClient();",
          "await client.paymentIntents.create({ amount: 2000 }, { idempotencyKey: requestId });",
          'await fetch("/pay", { headers: { Authorization: `Bearer ${token}` } });',
        ].join("\n"),
        "src/webhook.ts": "export function webhook(req) { return client.webhooks.verify(req.body, req.headers.signature); }",
      }),
      { runId: "run_clean_static", generatedAt: "2026-06-01T00:00:00.000Z" },
    );

    expect(result.gradeReport.findings).toEqual([]);
    expect(result.gradeReport.score.letter).toBe("A+");
  });

  it("finds generated code that leaks a secret literal", async () => {
    const result = await gradeWithReport(
      staticConfig("Create a small SDK example."),
      new ProjectSandbox({
        "package.json": JSON.stringify({ dependencies: {} }),
        "src/index.ts": 'export const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";',
      }),
      { runId: "run_secret_static", generatedAt: "2026-06-01T00:00:00.000Z" },
    );

    expect(findingCodes(result.gradeReport)).toContain("secret_in_client");
    expect(result.gradeReport.score.cap).toMatchObject({ maxGrade: "F" });
    expect(result.gradeReport.findings[0]?.evidence[0]?.customerExcerpt).toContain("[REDACTED]");
  });

  it("finds imported packages that are not declared", async () => {
    const result = await gradeWithReport(
      staticConfig("Build a Node integration."),
      new ProjectSandbox({
        "package.json": JSON.stringify({ dependencies: {} }),
        "src/index.ts": 'import { Client } from "made-up-sdk"; export const client = new Client();',
      }),
      { runId: "run_hallucinated_pkg", generatedAt: "2026-06-01T00:00:00.000Z" },
    );

    expect(findingCodes(result.gradeReport)).toContain("hallucinated_package");
  });

  it("finds expected SDK packages that were not discovered", async () => {
    const result = await gradeWithReport(
      staticConfig("Build the integration.", "npm install acme-payments-sdk"),
      new ProjectSandbox({
        "package.json": JSON.stringify({ dependencies: {} }),
        "src/index.ts": "export const client = {};",
      }),
      { runId: "run_sdk_missing", generatedAt: "2026-06-01T00:00:00.000Z" },
    );

    expect(findingCodes(result.gradeReport)).toContain("sdk_not_discovered");
  });

  it("does not require SDK packages for product-profile scenarios with no setup packages", async () => {
    const result = await gradeWithReport(
      {
        ...staticConfig("Build the HTTP integration.", "npm install acme-payments-sdk"),
        productProfile: productProfile([]),
      },
      new ProjectSandbox({
        "package.json": JSON.stringify({ dependencies: {} }),
        "src/index.ts": "await fetch('https://api.acme.test/v1/manage');",
      }),
      { runId: "run_http_no_sdk_expected", generatedAt: "2026-06-01T00:00:00.000Z" },
    );

    expect(findingCodes(result.gradeReport)).not.toContain("sdk_not_discovered");
    expect(result.gradeReport.taskPassed).toBe(true);
  });

  it("uses product-profile setup packages as required SDK expectations", async () => {
    const result = await gradeWithReport(
      {
        ...staticConfig("Build the SDK integration."),
        productProfile: productProfile([{ manager: "npm", name: "acme-payments-sdk" }]),
      },
      new ProjectSandbox({
        "package.json": JSON.stringify({ dependencies: {} }),
        "src/index.ts": "export const client = {};",
      }),
      { runId: "run_profile_sdk_missing", generatedAt: "2026-06-01T00:00:00.000Z" },
    );

    expect(findingCodes(result.gradeReport)).toContain("sdk_not_discovered");
  });

  it("finds auth schemes that contradict the docs", async () => {
    const result = await gradeWithReport(
      staticConfig("Build an authenticated request.", "Use Authorization: Bearer <token>."),
      new ProjectSandbox({
        "package.json": JSON.stringify({ dependencies: {} }),
        "src/index.ts": 'await fetch("/v1/items", { headers: { "x-api-key": token } });',
      }),
      { runId: "run_wrong_auth", generatedAt: "2026-06-01T00:00:00.000Z" },
    );

    expect(findingCodes(result.gradeReport)).toContain("wrong_auth_scheme");
  });

  it("finds webhook handlers without signature verification", async () => {
    const result = await gradeWithReport(
      staticConfig("Set up a webhook handler for payment_succeeded events."),
      new ProjectSandbox({
        "package.json": JSON.stringify({ dependencies: {} }),
        "src/index.ts": "export { webhook } from './webhook';",
        "src/webhook.ts": "export function webhook(req) { return handlePaymentSucceeded(req.body); }",
      }),
      { runId: "run_webhook_signature", generatedAt: "2026-06-01T00:00:00.000Z" },
    );

    expect(findingCodes(result.gradeReport)).toContain("missing_signature_verification");
  });

  it("finds money-moving requests without idempotency", async () => {
    const result = await gradeWithReport(
      staticConfig("Build checkout and create a payment intent."),
      new ProjectSandbox({
        "package.json": JSON.stringify({ dependencies: {} }),
        "src/index.ts": "await client.paymentIntents.create({ amount: 2000, currency: 'usd' });",
      }),
      { runId: "run_no_idempotency", generatedAt: "2026-06-01T00:00:00.000Z" },
    );

    expect(findingCodes(result.gradeReport)).toContain("no_idempotency");
  });

  it("runs configured dynamic probes and records dynamic evidence", async () => {
    const result = await gradeWithReport(
      {
        ...staticConfig("Reject invalid checkout requests."),
        dynamicProbes: [
          {
            name: "Malformed checkout is rejected",
            url: "http://localhost:3000/api/checkout",
            method: "POST",
            body: "{}",
            expectStatusMin: 400,
            expectStatusMax: 499,
            codeOnFail: "false_success_declaration",
          },
        ],
      },
      new ProjectSandbox(
        {
          "package.json": JSON.stringify({ dependencies: {} }),
          "src/index.ts": "export const ok = true;",
        },
        {
          "POST http://localhost:3000/api/checkout": { status: 200, body: "success" },
        },
      ),
      { runId: "run_dynamic_configured", generatedAt: "2026-06-01T00:00:00.000Z" },
    );

    const finding = result.gradeReport.findings.find((item) => item.code === "false_success_declaration");
    expect(finding?.evidence[0]?.type).toBe("dynamic");
    expect(finding?.evidence[0]?.replayCmd).toContain("curl -i -X POST");
  });

  it("infers forged webhook dynamic probes", async () => {
    const result = await gradeWithReport(
      staticConfig("Set up a webhook handler for payment_succeeded events."),
      new ProjectSandbox(
        {
          "package.json": JSON.stringify({ dependencies: {} }),
          "src/index.ts": "export { webhook } from './webhook';",
          "src/webhook.ts": "export function webhook(req) { return client.webhooks.verify(req.body, req.headers.signature); }",
        },
        {
          "POST http://localhost:3000/webhook": { status: 200, body: "ok" },
        },
      ),
      { runId: "run_dynamic_webhook", generatedAt: "2026-06-01T00:00:00.000Z" },
    );

    expect(findingCodes(result.gradeReport)).toContain("false_success_declaration");
  });

  it("adds trace metrics and trace findings", async () => {
    const repeated = { t: 1, kind: "warn" as const, text: "POST /v1/webhooks returned 404" };
    const result = await gradeWithReport(
      staticConfig("Build a webhook integration."),
      new ProjectSandbox({
        "package.json": JSON.stringify({ dependencies: {} }),
        "src/index.ts": "export const ok = true;",
      }),
      {
        runId: "run_trace",
        generatedAt: "2026-06-01T00:00:00.000Z",
        events: [repeated, { ...repeated, t: 2 }, { ...repeated, t: 3 }],
        runStats: { durationSec: 3, totalSteps: 3, tokens: 1200 },
      },
    );

    expect(result.gradeReport.traceMetrics).toMatchObject({
      durationSec: 3,
      totalSteps: 3,
      tokens: 1200,
      loopOnSameErrorCount: 3,
    });
    expect(findingCodes(result.gradeReport)).toContain("loop_on_same_error");
  });

  it("aggregates latest n completed run reports and flags unstable reruns", async () => {
    const passed = await gradeWithReport(
      staticConfig("Create src/index.ts."),
      new ProjectSandbox({
        "package.json": JSON.stringify({ dependencies: {} }),
        "src/index.ts": "export const ok = true;",
      }),
      { runId: "run_passed", generatedAt: "2026-06-01T00:00:00.000Z" },
    );
    const failed = await gradeWithReport(
      staticConfig("Create src/index.ts."),
      new ProjectSandbox({
        "package.json": JSON.stringify({ dependencies: {} }),
      }),
      { runId: "run_failed", generatedAt: "2026-06-01T00:01:00.000Z" },
    );

    const runs = aggregateCompletedRunReports(
      [
        {
          id: "run_passed",
          evalId: "eval_1",
          evalTitle: "Eval",
          task: "Create src/index.ts.",
          agentType: "claude-code",
          status: "completed",
          errorType: null,
          startedAt: "2026-06-01T00:00:00.000Z",
          finishedAt: "2026-06-01T00:00:01.000Z",
          durationSec: 1,
          totalSteps: 1,
          tokens: 100,
          events: [],
          verdicts: passed.verdicts,
          gradeReport: passed.gradeReport,
        },
        {
          id: "run_failed",
          evalId: "eval_1",
          evalTitle: "Eval",
          task: "Create src/index.ts.",
          agentType: "claude-code",
          status: "completed",
          errorType: null,
          startedAt: "2026-06-01T00:01:00.000Z",
          finishedAt: "2026-06-01T00:01:01.000Z",
          durationSec: 1,
          totalSteps: 1,
          tokens: 100,
          events: [],
          verdicts: failed.verdicts,
          gradeReport: failed.gradeReport,
        },
      ],
      2,
    );

    expect(runs[0]?.gradeReport?.score).toMatchObject({ runs: 2, passedRuns: 1, letter: "F" });
    expect(runs[0]?.gradeReport?.stability).toMatchObject({ stable: false });
    expect(runs[0]?.gradeReport?.runGroup).toMatchObject({ expectedRuns: 2, completedRuns: 2 });
  });
});

describe("AnthropicJudge", () => {
  it("parses the configured provider verdict", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return Response.json({
        content: [{ type: "text", text: '{"passed":true,"reasoning":"Uses the recommended pattern."}' }],
      });
    }) as typeof fetch;

    const result = await new AnthropicJudge("test-key", "test-model", fetchImpl).judge(
      "Uses recommended SDK patterns",
      "README artifact",
    );

    expect(result).toEqual({ passed: true, reasoning: "Uses the recommended pattern." });
    expect(requests[0]?.headers).toMatchObject({
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
    });
    expect(requests[0]?.body).toContain('"model":"test-model"');
  });
});
