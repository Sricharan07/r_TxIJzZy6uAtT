import { describe, expect, it } from "vitest";
import type { RunResult } from "@kiln/shared";
import { JsonKilnStore } from "@kiln/shared/store";
import { OzOrchestrator } from "./orchestrator";
import { buildOzReport, observeRunEvent } from "./index";
import { buildDocsMap } from "./agents/docs-mapper-agent";

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

const fetchImpl: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("registry.npmjs.org")) {
    return new Response(JSON.stringify({ "dist-tags": { latest: "1.2.3" } }), { status: 200 });
  }
  if (url.endsWith("/sitemap.xml")) {
    return response("<urlset><url><loc>https://acme.test/docs</loc></url></urlset>");
  }
  if (url.includes("/docs")) {
    return response(`
      <title>Acme Payments Docs</title>
      <h1>Quickstart</h1>
      <p>npm install @acme/payments</p>
      <p>Use ACME_API_KEY with Authorization: Bearer.</p>
      <p>Webhook signature verification is required.</p>
    `);
  }
  return response(`
    <title>Acme Payments</title>
    <a href="/docs">Docs</a>
    <a href="https://github.com/acme/payments-js">GitHub</a>
  `);
};

describe("OzOrchestrator", () => {
  it("discovers a product and produces an approval-ready suite", async () => {
    const store = new JsonKilnStore(`/tmp/kiln-oz-${Date.now()}.json`);
    const user = await store.getOrCreateDevUser();
    const oz = new OzOrchestrator({ store, fetchImpl });
    const job = await oz.createJob({ userId: user.id, productUrl: "https://acme.test", mode: "copilot" });
    const ready = await oz.runToApproval(job.id);

    expect(ready.status).toBe("awaiting_approval");
    expect(ready.state.productProfile?.productType).toContain("payments");
    expect(ready.state.productProfile?.requiredEnv.map((env) => env.name)).toContain("ACME_API_KEY");
    expect(ready.state.suiteDraft?.scenarios.length).toBeGreaterThanOrEqual(3);
    expect((await store.listOzEvents(job.id)).some((event) => event.kind === "suite.ready")).toBe(true);
  });

  it("builds API scenarios and env requirements when no SDK is documented", async () => {
    const restFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("registry.npmjs.org")) return new Response("{}", { status: 404 });
      if (url.endsWith("/sitemap.xml")) {
        return response("<urlset><url><loc>https://moss.test/docs</loc></url></urlset>");
      }
      if (url.includes("/docs")) {
        return response(`
          <title>Moss Docs</title>
          <h1>Authentication</h1>
          <p>Use curl against https://service.usemoss.dev/v1.</p>
          <p>All operations require the projectId field in the JSON body.</p>
          <pre><code>curl -X POST "https://service.usemoss.dev/v1/manage" -H "x-project-key: &lt;project-key&gt;" -H "x-service-version: v1" -d '{"action":"listIndexes","projectId":"project_123"}'</code></pre>
        `);
      }
      return response(`<title>Moss</title><a href="/docs">Docs</a>`);
    };
    const store = new JsonKilnStore(`/tmp/kiln-oz-rest-${Date.now()}.json`);
    const user = await store.getOrCreateDevUser();
    const oz = new OzOrchestrator({ store, fetchImpl: restFetch });
    const job = await oz.createJob({ userId: user.id, productUrl: "https://moss.test", mode: "copilot" });
    const ready = await oz.runToApproval(job.id);

    expect(ready.state.productProfile?.sdks).toHaveLength(0);
    expect(ready.state.productProfile?.requiredEnv.map((env) => env.name)).toContain("MOSS_PROJECT_KEY");
    expect(ready.state.productProfile?.requiredEnv.map((env) => env.name)).toContain("MOSS_PROJECT_ID");
    expect(ready.state.suiteDraft?.scenarios.some((scenario) => scenario.id === "http_client_init")).toBe(true);
    expect(ready.state.suiteDraft?.scenarios.some((scenario) => scenario.id === "sdk_import_init")).toBe(false);
  });

  it("keeps Oz run observations compact", () => {
    const event = observeRunEvent("job-1", "running", {
      t: 1,
      kind: "fail",
      text: "x".repeat(900),
      annotation: "details",
    }, "run-1:0");

    expect(event.dedupeKey).toBe("run-1:0");
    expect(event.message.length).toBeLessThan(540);
    expect(event.payload).not.toHaveProperty("sourceEvent");
  });

  it("groups docs map surfaces by source URL", () => {
    const docsMap = buildDocsMap({
      jobId: "job-1",
      userId: "user-1",
      input: { productUrl: "https://acme.test/docs", mode: "copilot" },
      discovery: {
        docsCandidates: [],
        selectedDocs: [{
          url: "https://acme.test/docs",
          title: "Acme Docs",
          text: "Quickstart authentication bearer token SDK npm install API reference example",
          links: [],
          fetchedAt: "2026-01-01T00:00:00.000Z",
        }],
        githubRepos: [],
        packages: [],
        codeExamples: [],
      },
    });

    expect(docsMap).toHaveLength(1);
    expect(docsMap[0]?.sourceUrl).toBe("https://acme.test/docs");
    expect(docsMap[0]?.surfaces).toEqual(expect.arrayContaining(["Quickstart", "Authentication", "SDK reference"]));
  });

  it("reports platform failures as inconclusive instead of product DX findings", () => {
    const run: RunResult = {
      id: "run-timeout",
      evalId: "eval-1",
      evalTitle: "Timeout eval",
      task: "Build integration",
      agentType: "claude-code",
      status: "errored",
      errorType: "timeout",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:30.000Z",
      durationSec: 30,
      totalSteps: 2,
      tokens: 100,
      events: [{ t: 30, kind: "fail", text: "Run failed before completion", annotation: "Run exceeded 30s timeout." }],
      verdicts: [],
    };
    const report = buildOzReport({
      jobId: "job-1",
      userId: "user-1",
      input: { productUrl: "https://example.test", mode: "copilot" },
      discovery: { docsCandidates: [], selectedDocs: [], githubRepos: [], packages: [], codeExamples: [] },
    }, [run]);

    expect(report.summary).toContain("inconclusive");
    expect(report.findings[0]?.code).toBe("platform_timeout");
    expect(report.recommendedFixes[0]?.target).toBe("environment");
  });
});
