import { describe, expect, it } from "vitest";
import { JsonKilnStore } from "@kiln/shared/store";
import { OzOrchestrator } from "./orchestrator";

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
});
