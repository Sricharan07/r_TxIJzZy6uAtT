import { describe, expect, it } from "vitest";
import type { GradeReport, OzAgentState, RunResult } from "@kiln/shared";
import { JsonKilnStore } from "@kiln/shared/store";
import { OzOrchestrator } from "./orchestrator";
import { buildOzReport, observeRunEvent } from "./index";
import { buildDocsMap } from "./agents/docs-mapper-agent";
import { runDocsResearchAgent } from "./agents/docs-research-agent";
import { scenarioToEvalConfig } from "./eval-config";

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function reportState(): OzAgentState {
  return {
    jobId: "job-1",
    userId: "user-1",
    input: { productUrl: "https://example.test", mode: "copilot" },
    discovery: {
      docsCandidates: [],
      selectedDocs: [{
        url: "https://example.test/docs/quickstart",
        title: "Quickstart",
        text: "Install @acme/sdk, use Authorization Bearer, and call POST /v1/widgets with name.",
        links: [],
        fetchedAt: "2026-01-01T00:00:00.000Z",
      }],
      githubRepos: [],
      packages: [],
      codeExamples: [],
    },
    productProfile: {
      companyName: "Acme",
      productName: "Acme",
      productType: ["api", "sdk", "auth"],
      summary: "Acme API and SDK.",
      auth: {
        scheme: "bearer",
        headerName: "Authorization",
        envVars: ["ACME_API_KEY"],
        evidence: [{ source: "https://example.test/docs/auth", quote: "Use Authorization: Bearer.", confidence: 0.86 }],
      },
      sdks: [{
        language: "node",
        packageName: "@acme/sdk",
        manager: "npm",
        evidence: [{ source: "https://example.test/docs/sdk", quote: "npm install @acme/sdk", confidence: 0.88 }],
      }],
      APIs: [{
        name: "POST /v1/widgets",
        method: "POST",
        path: "/v1/widgets",
        description: "Create widget.",
        evidence: [{ source: "https://example.test/docs/api", quote: "POST /v1/widgets", confidence: 0.84 }],
      }],
      webhooks: [],
      requiredEnv: [{ name: "ACME_API_KEY", scopes: ["agent", "assertion"], required: true }],
      confidence: 0.9,
      evidence: [{ source: "https://example.test/docs", quote: "Product docs were classified.", confidence: 0.8 }],
    },
  };
}

function reportRun(patch: Partial<RunResult>): RunResult {
  return {
    id: "run-1",
    evalId: "eval-1",
    evalTitle: "Eval",
    task: "Build integration",
    agentType: "claude-code",
    status: "completed",
    errorType: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:30.000Z",
    durationSec: 30,
    totalSteps: 4,
    tokens: 900,
    events: [],
    verdicts: [],
    ...patch,
  };
}

function passingGradeReport(runId = "run-1"): GradeReport {
  return {
    runId,
    taskSpecId: "task",
    mode: "integration-build",
    buildPhase: "slice-1",
    taskPassed: true,
    score: {
      raw: 100,
      capped: 100,
      letter: "A+",
      passRate: 1,
      confidenceInterval: { low: 0.21, high: 1 },
      runs: 1,
      passedRuns: 1,
    },
    findings: [],
    agentMatrix: [],
    definitionOfDone: [],
    generatedAt: "2026-01-01T00:00:31.000Z",
  };
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
          <p>VAPI can be connected through a separate integration guide.</p>
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
    expect(ready.state.productProfile?.requiredEnv.map((env) => env.name)).not.toContain("VAPI");
    expect(ready.state.suiteDraft?.scenarios.some((scenario) => scenario.id === "http_client_init")).toBe(true);
    expect(ready.state.suiteDraft?.scenarios.some((scenario) => scenario.id === "sdk_import_init")).toBe(false);
    const firstCall = ready.state.suiteDraft?.scenarios.find((scenario) => scenario.id === "first_successful_call");
    expect(firstCall?.task).toContain("src/index.mjs");
    expect(firstCall?.task).toContain("Never print, echo, log, serialize, or write secret environment variable values");
    expect(firstCall?.assertions).toEqual(
      expect.arrayContaining([
        { type: "file", name: "Integration entrypoint exists", config: { path: "src/index.mjs" } },
        { type: "shell", name: "Project command succeeds", config: { command: "node src/index.mjs" } },
      ]),
    );
    const secretAssertions = firstCall?.assertions.filter((assertion) => assertion.name.startsWith("Secret is not printed")) ?? [];
    expect(secretAssertions.map((assertion) => assertion.name)).toEqual(["Secret is not printed: MOSS_PROJECT_KEY"]);
    expect(secretAssertions[0]?.config).toMatchObject({ command: expect.stringContaining("sh -c") });
  });

  it("detects SDK packages, symbols, and methods from docs text", async () => {
    const sdkFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("registry.npmjs.org")) {
        return new Response(JSON.stringify({ "dist-tags": { latest: "2.0.0" } }), { status: 200 });
      }
      if (url.endsWith("/sitemap.xml")) {
        return response("<urlset><url><loc>https://vector.test/docs/sdk</loc></url></urlset>");
      }
      if (url.includes("/docs/sdk")) {
        return response(`
          <title>Vector Docs</title>
          <h1>JavaScript SDK</h1>
          <p>npm install @vector/search</p>
          <pre><code>
            import { VectorClient, SearchIndex } from "@vector/search";
            const client = new VectorClient({ apiKey: process.env.VECTOR_API_KEY });
            await client.addDocs("idx", []);
            await client.query("idx", "hello");
          </code></pre>
        `);
      }
      return response(`<title>Vector</title><a href="/docs/sdk">Docs</a>`);
    };
    const store = new JsonKilnStore(`/tmp/kiln-oz-sdk-${Date.now()}.json`);
    const user = await store.getOrCreateDevUser();
    const oz = new OzOrchestrator({ store, fetchImpl: sdkFetch });
    const job = await oz.createJob({ userId: user.id, productUrl: "https://vector.test", mode: "copilot" });
    const ready = await oz.runToApproval(job.id);

    const sdk = ready.state.productProfile?.sdks.find((item) => item.packageName === "@vector/search");
    expect(sdk).toBeDefined();
    expect(sdk?.symbols).toEqual(expect.arrayContaining(["VectorClient", "SearchIndex"]));
    expect(sdk?.methods).toEqual(expect.arrayContaining(["addDocs", "query"]));
    expect(ready.state.suiteDraft?.scenarios.some((scenario) => scenario.id === "sdk_import_init")).toBe(true);
  });

  it("uses llms.txt and balanced docs coverage to find SDK pages", async () => {
    const mossFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("registry.npmjs.org")) {
        return new Response(JSON.stringify({ "dist-tags": { latest: "1.0.0" } }), { status: 200 });
      }
      if (url.endsWith("/llms.txt")) {
        return new Response([
          "# Moss Docs",
          "- [Authentication](https://moss-sdk.test/docs/api-reference/v1/getting-started/authentication)",
          "- [JavaScript SDK](https://moss-sdk.test/docs/reference/js/api)",
        ].join("\n"), { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (url.endsWith("/sitemap.xml")) {
        return response(`
          <urlset>
            <url><loc>https://moss-sdk.test/docs/api-reference/v1/getting-started/authentication</loc></url>
            <url><loc>https://moss-sdk.test/docs/api-reference/v1/document-operations/addDocs</loc></url>
            <url><loc>https://moss-sdk.test/docs/api-reference/v1/document-operations/getDocs</loc></url>
          </urlset>
        `);
      }
      if (url.includes("/docs/reference/js/api")) {
        return response(`
          <title>Moss JavaScript SDK</title>
          <h1>JavaScript SDK</h1>
          <p>npm install @moss-dev/moss</p>
          <pre><code>
            import { MossClient, SessionIndex } from "@moss-dev/moss";
            const client = new MossClient({ projectId: process.env.MOSS_PROJECT_ID, apiKey: process.env.MOSS_PROJECT_KEY });
            const index = await SessionIndex.create(client, { name: "kiln" });
            await index.addDocs([{ id: "1", text: "hello" }]);
            await index.query("hello");
          </code></pre>
        `);
      }
      if (url.includes("/authentication")) {
        return response(`
          <title>Moss Authentication</title>
          <h1>Authentication</h1>
          <p>Use x-project-key and projectId for API requests.</p>
        `);
      }
      if (url.includes("/document-operations")) {
        return response(`<title>Moss API</title><p>POST /v1/manage document operation.</p>`);
      }
      return response(`<title>Moss Docs</title><a href="/docs/api-reference/v1/getting-started/authentication">Authentication</a>`);
    };
    const store = new JsonKilnStore(`/tmp/kiln-oz-llms-${Date.now()}.json`);
    const user = await store.getOrCreateDevUser();
    const oz = new OzOrchestrator({ store, fetchImpl: mossFetch });
    const job = await oz.createJob({ userId: user.id, productUrl: "https://moss-sdk.test/docs", mode: "copilot" });
    const ready = await oz.runToApproval(job.id);

    const selectedUrls = ready.state.discovery.selectedDocs.map((page) => page.url);
    expect(selectedUrls).toContain("https://moss-sdk.test/docs/reference/js/api");
    const sdk = ready.state.productProfile?.sdks.find((item) => item.packageName === "@moss-dev/moss");
    expect(sdk).toBeDefined();
    expect(sdk?.symbols).toEqual(expect.arrayContaining(["MossClient", "SessionIndex"]));
    expect(sdk?.methods).toEqual(expect.arrayContaining(["addDocs", "query"]));
    expect(ready.state.suiteDraft?.scenarios.some((scenario) => scenario.id === "sdk_import_init")).toBe(true);
    const firstCall = ready.state.suiteDraft?.scenarios.find((scenario) => scenario.id === "first_successful_call");
    expect(firstCall).toBeDefined();
    expect(firstCall?.assertions.some((assertion) => assertion.name.startsWith("Official SDK is referenced"))).toBe(false);
    expect(firstCall?.assertions.find((assertion) => assertion.name.includes("/v1/manage"))?.config).toMatchObject({
      command: expect.stringContaining("sh -c"),
    });
    const firstCallConfig = scenarioToEvalConfig({ state: ready.state, scenario: firstCall! });
    expect(firstCallConfig.productProfile?.packages).toEqual([]);
    expect(firstCallConfig.productProfile?.runtime.image).toBe("default");
    expect(firstCallConfig.context[0]?.content).toContain("Primary SDK for this node scenario: @moss-dev/moss");
    const sdkScenario = ready.state.suiteDraft?.scenarios.find((scenario) => scenario.id === "sdk_import_init");
    expect(sdkScenario).toBeDefined();
    expect(sdkScenario?.assertions.some((assertion) => assertion.name === "Official SDK is referenced: @moss-dev/moss")).toBe(true);
    const sdkConfig = scenarioToEvalConfig({ state: ready.state, scenario: sdkScenario! });
    expect(sdkConfig.productProfile?.packages?.map((pkg) => `${pkg.manager}:${pkg.name}`)).toEqual(["npm:@moss-dev/moss"]);
    expect(sdkConfig.productProfile?.runtime).toMatchObject({ image: "ubuntu-24.04-node22", nodeVersion: ">=22" });
  });

  it("researches cross-source claims and reports docs/package inconsistencies", async () => {
    const researchFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://registry.npmjs.org/%40moss-dev%2Fmoss") {
        return new Response(JSON.stringify({
          "dist-tags": { latest: "1.1.0" },
          versions: {
            "1.1.0": {
              version: "1.1.0",
              license: "PolyForm Shield",
              engines: { node: ">=20" },
              types: "dist/moss.d.ts",
              main: "dist/index.js",
              repository: { url: "https://github.com/usemoss/moss.git", directory: "packages/moss" },
            },
          },
          readme: "Without loadIndex(): every query() call goes to the cloud API.",
        }), { status: 200 });
      }
      if (url === "https://unpkg.com/@moss-dev/moss@1.1.0/package.json") {
        return new Response(JSON.stringify({
          name: "@moss-dev/moss",
          version: "1.1.0",
          license: "PolyForm Shield",
          engines: { node: ">=20" },
          types: "dist/moss.d.ts",
          main: "dist/index.js",
          repository: { url: "https://github.com/usemoss/moss.git", directory: "packages/moss" },
        }), { status: 200 });
      }
      if (url === "https://unpkg.com/@moss-dev/moss@1.1.0/dist/moss.d.ts") {
        return new Response([
          "export declare class MossClient {",
          "  constructor(input: unknown);",
          "}",
          "export declare class SessionIndex {",
          "  static create(client: MossClient, input: unknown): Promise<SessionIndex>;",
          "  addDocs(input: unknown): Promise<void>;",
          "  query(input: string): Promise<unknown>;",
          "}",
        ].join("\n"), { status: 200 });
      }
      if (url === "https://unpkg.com/@moss-dev/moss@1.1.0/dist/index.js") {
        return new Response("export {}", { status: 200 });
      }
      if (url === "https://raw.githubusercontent.com/usemoss/moss/main/README.md") {
        return new Response([
          "# Moss",
          "Requires Node.js 20+.",
          "License: BSD-2-Clause.",
        ].join("\n"), { status: 200 });
      }
      if (url === "https://raw.githubusercontent.com/usemoss/moss/v1.1.0/packages/moss/README.md") {
        return new Response([
          "# Moss package",
          "Requires Node.js 20+.",
          "Without loadIndex(): every query() call goes to the cloud API.",
        ].join("\n"), { status: 200 });
      }
      if (url === "https://raw.githubusercontent.com/usemoss/moss/v1.1.0/packages/moss/package.json") {
        return new Response(JSON.stringify({
          name: "@moss-dev/moss",
          license: "PolyForm Shield",
          engines: { node: ">=20" },
        }), { status: 200 });
      }
      if (url === "https://raw.githubusercontent.com/usemoss/moss/main/package.json") {
        return new Response(JSON.stringify({ license: "BSD-2-Clause", engines: { node: ">=20" } }), { status: 200 });
      }
      if (url.includes("registry.npmjs.org")) return new Response("{}", { status: 404 });
      if (url.endsWith("/sitemap.xml")) {
        return response("<urlset><url><loc>https://moss-research.test/docs/start/quickstart</loc></url></urlset>");
      }
      if (url.includes("/docs/start/quickstart")) {
        return response(`
          <title>Moss Quickstart</title>
          <h1>Quickstart</h1>
          <p>Prerequisites: Node.js 18+ or Python 3.10+.</p>
          <p>Valid Moss project credentials: MOSS_PROJECT_ID and MOSS_PROJECT_KEY.</p>
          <pre><code>npm install @moss-dev/moss</code></pre>
          <pre><code>
            import { MossClient, SessionIndex, CloudIndex } from "@moss-dev/moss";
            const client = new MossClient({ projectId: process.env.MOSS_PROJECT_ID, apiKey: process.env.MOSS_PROJECT_KEY });
            const index = await SessionIndex.create(client, { name: "kiln" });
            await index.loadIndex();
            await index.addDocs([{ id: "1", text: "hello" }]);
            await index.query("hello");
          </code></pre>
          <p>Use x-project-key and projectId for REST API calls.</p>
          <p>Call loadIndex() before query().</p>
        `);
      }
      return response(`
        <title>Moss</title>
        <a href="/docs/start/quickstart">Quickstart</a>
        <a href="https://github.com/usemoss/moss">GitHub</a>
      `);
    };
    const store = new JsonKilnStore(`/tmp/kiln-oz-research-${Date.now()}.json`);
    const user = await store.getOrCreateDevUser();
    const oz = new OzOrchestrator({ store, fetchImpl: researchFetch });
    const job = await oz.createJob({ userId: user.id, productUrl: "https://moss-research.test", mode: "copilot" });
    const ready = await oz.runToApproval(job.id);

    const conflictIds = ready.state.research?.conflicts.map((conflict) => conflict.id) ?? [];
    expect(conflictIds).toEqual(expect.arrayContaining([
      "runtime-node-version-mismatch",
      "license-claim-mismatch",
      "auth-shape-ambiguity",
      "query-load-semantics-ambiguous",
      "sdk-symbols-missing-moss-dev-moss",
      "sdk-methods-missing-moss-dev-moss",
    ]));
    const artifact = (await store.listOzArtifacts(job.id)).find((item) => item.type === "research_report");
    expect(artifact?.data).toMatchObject({ conflicts: expect.any(Array), claims: expect.any(Array) });
    expect(ready.state.research?.checkedSources).toContain("https://raw.githubusercontent.com/usemoss/moss/v1.1.0/packages/moss/package.json");
    expect(ready.state.suiteDraft?.scenarios.map((scenario) => scenario.id)).toEqual(expect.arrayContaining([
      "sdk_symbol_claim_consistency_moss_dev_moss",
      "sdk_method_claim_consistency_moss_dev_moss",
      "sdk_query_load_semantics",
      "auth_claim_mapping_consistency",
      "runtime_claim_consistency_node",
    ]));
    const sdkSymbolScenario = ready.state.suiteDraft?.scenarios.find((scenario) => scenario.id === "sdk_symbol_claim_consistency_moss_dev_moss");
    expect(sdkSymbolScenario?.assertions.map((assertion) => assertion.name)).toEqual(expect.arrayContaining([
      expect.stringContaining("Published SDK exports documented symbols"),
    ]));
    const sdkMethodScenario = ready.state.suiteDraft?.scenarios.find((scenario) => scenario.id === "sdk_method_claim_consistency_moss_dev_moss");
    expect(sdkMethodScenario?.assertions.map((assertion) => assertion.name)).toEqual(expect.arrayContaining([
      expect.stringContaining("Installed SDK contains documented methods"),
    ]));
    const events = await store.listOzEvents(job.id);
    expect(events.some((event) => event.kind === "finding.created" && event.message.includes("Node runtime"))).toBe(true);

    const report = buildOzReport(ready.state, [reportRun({ gradeReport: passingGradeReport() })]);
    expect(report.frictionInsights.map((insight) => insight.id)).toEqual(expect.arrayContaining([
      "research:runtime-node-version-mismatch",
      "research:license-claim-mismatch",
      "research:auth-shape-ambiguity",
      "research:query-load-semantics-ambiguous",
      "research:sdk-symbols-missing-moss-dev-moss",
      "research:sdk-methods-missing-moss-dev-moss",
    ]));
    expect(report.recommendedFixes.some((fix) => fix.title === "Node runtime requirement is inconsistent across sources")).toBe(true);
  });

  it("does not turn unavailable package probe sources into SDK conflicts", async () => {
    const state = reportState();
    state.productProfile!.sdks = [{
      ...state.productProfile!.sdks[0]!,
      packageName: "@acme/sdk",
      symbols: ["AcmeClient"],
      methods: ["createWidget"],
    }];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://registry.npmjs.org/%40acme%2Fsdk") {
        return new Response(JSON.stringify({
          "dist-tags": { latest: "2.0.0" },
          versions: {
            "2.0.0": {
              version: "2.0.0",
              types: "dist/index.d.ts",
              main: "dist/index.js",
            },
          },
        }), { status: 200 });
      }
      if (url.startsWith("https://unpkg.com/@acme/sdk@2.0.0/")) {
        return new Response("temporary upstream outage", { status: 503 });
      }
      return new Response("", { status: 404 });
    };

    const researched = await runDocsResearchAgent(state, { jobId: "job-1", userId: "user-1", fetchImpl });
    const conflictIds = researched.research?.conflicts.map((conflict) => conflict.id) ?? [];
    expect(conflictIds).not.toEqual(expect.arrayContaining([
      "sdk-types-unavailable-acme-sdk",
      "sdk-symbols-missing-acme-sdk",
      "sdk-methods-missing-acme-sdk",
      "package-entrypoint-missing-acme-sdk",
    ]));
    expect(researched.research?.checkedSources).toEqual(expect.arrayContaining([
      "https://unpkg.com/@acme/sdk@2.0.0/package.json",
      "https://unpkg.com/@acme/sdk@2.0.0/dist/index.d.ts",
    ]));
  });

  it("researches Python package runtime and import-name inconsistencies", async () => {
    const state = reportState();
    state.discovery.selectedDocs = [{
      url: "https://example.test/docs/python",
      title: "Python SDK",
      text: [
        "Python 3.10+ is required.",
        "pip install acme-vector",
        "from acme_vector import VectorClient",
      ].join("\n"),
      links: [],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    }];
    state.discovery.packages = [{
      manager: "pip",
      name: "acme-vector",
      confidence: 0.9,
      evidence: [{ source: "https://example.test/docs/python", quote: "pip install acme-vector", confidence: 0.9 }],
    }];
    state.productProfile!.sdks = [{
      language: "python",
      manager: "pip",
      packageName: "acme-vector",
      evidence: [{ source: "https://example.test/docs/python", quote: "pip install acme-vector", confidence: 0.9 }],
    }];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://pypi.org/pypi/acme-vector/json") {
        return new Response(JSON.stringify({
          info: {
            version: "1.0.0",
            license: "MIT",
            requires_python: ">=3.11",
            description: "Use `from acme import VectorClient` after installation.",
          },
        }), { status: 200 });
      }
      return new Response("", { status: 404 });
    };

    const researched = await runDocsResearchAgent(state, { jobId: "job-1", userId: "user-1", fetchImpl });
    expect(researched.research?.conflicts.map((conflict) => conflict.id)).toEqual(expect.arrayContaining([
      "runtime-python-version-mismatch",
      "python-import-module-mismatch-acme-vector",
    ]));
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

  it("does not fail Oz reports for advisory-only LLM verdicts", () => {
    const run: RunResult = {
      id: "run-advisory",
      evalId: "eval-1",
      evalTitle: "Advisory eval",
      task: "Build integration",
      agentType: "claude-code",
      status: "completed",
      errorType: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:30.000Z",
      durationSec: 30,
      totalSteps: 2,
      tokens: 100,
      events: [{ t: 1, kind: "info", text: "Completed integration" }],
      verdicts: [
        { assertionIndex: 0, type: "file", name: "entry exists", passed: true },
        { assertionIndex: 1, type: "llm", name: "advisory pattern check", passed: false },
      ],
      gradeReport: passingGradeReport("run-advisory"),
    };
    const report = buildOzReport({
      jobId: "job-1",
      userId: "user-1",
      input: { productUrl: "https://example.test", mode: "copilot" },
      discovery: { docsCandidates: [], selectedDocs: [], githubRepos: [], packages: [], codeExamples: [] },
    }, [run]);

    expect(report.summary).toContain("1/1 agent run passed");
    expect(report.findings).toEqual([]);
  });

  it("does not classify self-attested HTTP text as runtime success", () => {
    const run: RunResult = {
      id: "run-harness",
      evalId: "eval-1",
      evalTitle: "Harness eval",
      task: "Build integration",
      agentType: "claude-code",
      status: "completed",
      errorType: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:30.000Z",
      durationSec: 30,
      totalSteps: 4,
      tokens: 900,
      events: [{ t: 10, kind: "api", text: 'Response (HTTP 200): {"ok":true}' }],
      verdicts: [
        { assertionIndex: 0, type: "file", name: "Integration entrypoint exists", passed: true },
        { assertionIndex: 1, type: "shell", name: "Project command succeeds", passed: true },
        { assertionIndex: 2, type: "shell", name: "Result contract reports success", passed: true },
        { assertionIndex: 3, type: "shell", name: "Documented product surface is referenced: /v1/manage", passed: false },
      ],
      gradeReport: {
        runId: "run-harness",
        taskSpecId: "task",
        mode: "integration-build",
        buildPhase: "slice-1",
        taskPassed: false,
        score: {
          raw: 0,
          capped: 0,
          letter: "F",
          passRate: 0,
          confidenceInterval: { low: 0, high: 1 },
          runs: 1,
          passedRuns: 0,
        },
        findings: [{
          id: "finding-1",
          runId: "run-harness",
          taskSpecId: "task",
          code: "documented_surface_not_referenced",
          title: "Documented product surface is referenced: /v1/manage",
          severity: "low",
          status: "confirmed",
          canHardCap: false,
          evidence: [],
          codeVsNoCode: "mixed",
        }],
        agentMatrix: [],
        definitionOfDone: [],
        generatedAt: "2026-01-01T00:00:31.000Z",
      },
    };
    const report = buildOzReport({
      jobId: "job-1",
      userId: "user-1",
      input: { productUrl: "https://example.test", mode: "copilot" },
      discovery: { docsCandidates: [], selectedDocs: [], githubRepos: [], packages: [], codeExamples: [] },
    }, [run]);

    expect(report.findings[0]?.code).not.toBe("docs_ambiguous");
    expect(report.findings[0]?.code).not.toBe("harness_issue");
  });

  it("classifies secret-print failures as agent security issues", () => {
    const run: RunResult = {
      id: "run-secret",
      evalId: "eval-1",
      evalTitle: "Secret eval",
      task: "Build integration",
      agentType: "claude-code",
      status: "completed",
      errorType: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:30.000Z",
      durationSec: 30,
      totalSteps: 4,
      tokens: 900,
      events: [
        { t: 1, kind: "command", text: "echo \"$MOSS_PROJECT_KEY\"" },
        { t: 2, kind: "info", text: "MOSS_PROJECT_KEY=[redacted:MOSS_PROJECT_KEY]" },
        { t: 10, kind: "api", text: 'HTTP 200 {"ok":true}' },
      ],
      verdicts: [
        { assertionIndex: 0, type: "file", name: "Integration entrypoint exists", passed: true },
        { assertionIndex: 1, type: "shell", name: "Project command succeeds", passed: true },
        { assertionIndex: 2, type: "shell", name: "Result contract reports success", passed: true },
        { assertionIndex: 3, type: "shell", name: "Secret is not printed: MOSS_PROJECT_KEY", passed: false },
      ],
    };
    const report = buildOzReport({
      jobId: "job-1",
      userId: "user-1",
      input: { productUrl: "https://example.test", mode: "copilot" },
      discovery: { docsCandidates: [], selectedDocs: [], githubRepos: [], packages: [], codeExamples: [] },
    }, [run]);

    expect(report.findings[0]?.code).toBe("agent_secret_exposure");
    expect(report.recommendedFixes[0]?.target).toBe("agent");
    expect(report.frictionInsights[0]).toMatchObject({
      category: "agent",
      status: "confirmed",
      title: "Agent exposed credential values while debugging",
    });
  });

  it("reports no meaningful friction when an API run succeeds cleanly", () => {
    const report = buildOzReport(reportState(), [reportRun({
      events: [{ t: 10, kind: "api", text: 'HTTP 200 {"ok":true}' }],
      verdicts: [
        { assertionIndex: 0, type: "file", name: "Integration entrypoint exists", passed: true },
        { assertionIndex: 1, type: "shell", name: "Project command succeeds", passed: true, output: "HTTP 200" },
        { assertionIndex: 2, type: "shell", name: "Result contract reports success", passed: true, output: '{"ok":true}' },
      ],
      gradeReport: passingGradeReport(),
    })]);

    expect(report.behaviorSummary).toMatchObject({ totalRuns: 1, passedRuns: 1, failedRuns: 0 });
    expect(report.frictionInsights[0]).toMatchObject({
      category: "docs",
      status: "informational",
      title: "No meaningful doc friction detected in this run",
    });
  });

  it("classifies native SDK setup failures as environment friction with SDK evidence", () => {
    const report = buildOzReport(reportState(), [reportRun({
      id: "run-native",
      status: "errored",
      errorType: "platform",
      events: [
        { t: 0, kind: "command", text: "Product setup: Install @acme/sdk" },
        { t: 0, kind: "fail", text: "Run failed before completion", annotation: "Cannot find native binding. /lib/x86_64-linux-gnu/libc.so.6: version GLIBC_2.38 not found." },
      ],
      verdicts: [],
    })]);

    expect(report.findings[0]?.code).toBe("environment_issue");
    expect(report.frictionInsights[0]).toMatchObject({
      category: "environment",
      title: "SDK setup depends on undocumented or unavailable native runtime support",
      status: "confirmed",
    });
    expect(report.frictionInsights[0]?.docsEvidence[0]?.source).toBe("https://example.test/docs/sdk");
  });

  it("classifies authentication rejection as auth doc friction", () => {
    const report = buildOzReport(reportState(), [reportRun({
      events: [{ t: 4, kind: "api", text: "HTTP 401 Unauthorized" }],
      verdicts: [
        { assertionIndex: 0, type: "shell", name: "Project command succeeds", passed: false, output: "401 Unauthorized" },
      ],
    })]);

    expect(report.findings[0]?.code).toBe("auth_confusion");
    expect(report.frictionInsights[0]).toMatchObject({
      category: "auth",
      title: "Agent could not apply the documented auth model",
    });
    expect(report.recommendedFixes.some((fix) => fix.target === "docs")).toBe(true);
  });

  it("surfaces request-shape trial and error even when the final call passes", () => {
    const report = buildOzReport(reportState(), [reportRun({
      events: [
        { t: 4, kind: "api", text: "HTTP 422 missing required field name" },
        { t: 8, kind: "api", text: "HTTP 400 bad request" },
        { t: 12, kind: "api", text: 'HTTP 200 {"ok":true}' },
      ],
      verdicts: [
        { assertionIndex: 0, type: "file", name: "Integration entrypoint exists", passed: true },
        { assertionIndex: 1, type: "shell", name: "Project command succeeds", passed: true, output: "HTTP 200" },
        { assertionIndex: 2, type: "shell", name: "Result contract reports success", passed: true, output: '{"ok":true}' },
      ],
      gradeReport: passingGradeReport(),
    })]);

    expect(report.findings).toEqual([]);
    expect(report.frictionInsights.some((insight) =>
      insight.category === "api" && insight.title === "Agent succeeded only after API trial and error"
    )).toBe(true);
    expect(report.recommendedFixes.some((fix) => fix.title === "Agent succeeded only after API trial and error")).toBe(true);
  });

  it("promotes repeated suspected friction across runs to confirmed", () => {
    const makeLoopRun = (id: string) => reportRun({
      id,
      events: [
        { t: 1, kind: "warn", text: "TypeError: undefined method" },
        { t: 2, kind: "warn", text: "TypeError: undefined method" },
        { t: 3, kind: "warn", text: "TypeError: undefined method" },
      ],
      verdicts: [{ assertionIndex: 0, type: "shell", name: "Project command succeeds", passed: false }],
    });
    const report = buildOzReport(reportState(), [makeLoopRun("run-a"), makeLoopRun("run-b")]);

    expect(report.frictionInsights.find((insight) => insight.id === "friction:agent_looped_on_same_error")).toMatchObject({
      status: "confirmed",
      affectedRunIds: ["run-a", "run-b"],
    });
  });
});
