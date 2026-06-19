import type { DynamicProbe, Finding, HttpMethod, Severity } from "@kiln/shared";
import type { HttpRequest } from "../sandbox.js";
import {
  contextText,
  makeEvidence,
  makeFinding,
  sourceArtifacts,
  type StaticArtifact,
  type StaticGraderContext,
} from "../static/shared.js";

function textSuggestsWebhook(text: string): boolean {
  return /\bwebhook(s)?\b/i.test(text);
}

function textSuggestsInputValidation(text: string): boolean {
  return /\b(rest|api|checkout|payment|charge|create|intent)\b/i.test(text);
}

function sourceMentionsWebhook(artifact: StaticArtifact): boolean {
  return /\bwebhook(s)?\b|payment_succeeded/i.test(`${artifact.path}\n${artifact.contents}`);
}

function sourceMentionsMoneyOrApi(artifact: StaticArtifact): boolean {
  return /paymentIntents?\.create|charges?\.create|checkout\.sessions?\.create|fetch\(|axios\.|http\./i.test(
    artifact.contents,
  );
}

function configuredProbeToRequest(probe: DynamicProbe): HttpRequest {
  return {
    url: probe.url,
    method: probe.method ?? "GET",
    headers: probe.headers,
    body: probe.body,
  };
}

function statusInRange(status: number, min?: number, max?: number): boolean {
  if (min !== undefined && status < min) return false;
  if (max !== undefined && status > max) return false;
  return true;
}

function probeFailed(probe: DynamicProbe, status: number, body: string): string | null {
  if (probe.expectStatus !== undefined && status !== probe.expectStatus) {
    return `Expected HTTP ${probe.expectStatus} but got ${status}.`;
  }
  if (
    (probe.expectStatusMin !== undefined || probe.expectStatusMax !== undefined) &&
    !statusInRange(status, probe.expectStatusMin, probe.expectStatusMax)
  ) {
    return `Expected HTTP status in configured range but got ${status}.`;
  }
  if (probe.expectBodyContains && !body.includes(probe.expectBodyContains)) {
    return `Response did not contain expected substring "${probe.expectBodyContains}".`;
  }
  if (probe.expectBodyNotContains && body.includes(probe.expectBodyNotContains)) {
    return `Response contained forbidden substring "${probe.expectBodyNotContains}".`;
  }
  return null;
}

function replayFor(request: HttpRequest): string {
  const method = request.method ?? "GET";
  const headers = Object.entries(request.headers ?? {})
    .map(([name, value]) => ` -H '${name}: ${value.replace(/'/g, `'\\''`)}'`)
    .join("");
  const body = request.body === undefined ? "" : ` --data-binary '${request.body.replace(/'/g, `'\\''`)}'`;
  return `curl -i -X ${method}${headers}${body} '${request.url.replace(/'/g, `'\\''`)}'`;
}

function configuredSeverity(probe: DynamicProbe): Severity {
  return probe.severityOnFail ?? "high";
}

interface ProbeRun {
  probe: DynamicProbe;
  request: HttpRequest;
  status: number;
  body: string;
  failure: string | null;
}

function isSuccessProbe(probe: DynamicProbe): boolean {
  return probe.verificationRole === "success";
}

async function executeConfiguredProbes(context: StaticGraderContext): Promise<ProbeRun[]> {
  const runs: ProbeRun[] = [];
  for (const probe of context.config.dynamicProbes ?? []) {
    const request = configuredProbeToRequest(probe);
    const result = await context.sandbox.httpRequest(request);
    runs.push({
      probe,
      request,
      status: result.status,
      body: result.body,
      failure: probeFailed(probe, result.status, result.body),
    });
  }
  return runs;
}

function configuredProbeFindings(context: StaticGraderContext, probeRuns: ProbeRun[]): Finding[] {
  const findings: Finding[] = [];
  for (const { probe, request, status, body, failure } of probeRuns) {
    if (!failure) continue;
    findings.push(
      makeFinding({
        context,
        code: probe.codeOnFail ?? "dynamic_probe_failed",
        title: probe.name,
        severity: configuredSeverity(probe),
        canHardCap: probe.canHardCap ?? configuredSeverity(probe) === "critical",
        hardCapGrade: probe.hardCapGrade,
        evidence: [
          makeEvidence({
            type: "dynamic",
            replayCmd: replayFor(request),
            excerpt: `${failure}\nHTTP ${status}\n${body}`,
            observedAt: context.observedAt,
          }),
        ],
      }),
    );
  }
  return findings;
}

function parseAgentResultClaim(contents: string | null): Record<string, unknown> | null {
  if (!contents) return null;
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function runSuccessClaimVerifier(
  context: StaticGraderContext,
  probeRuns: ProbeRun[],
): Promise<Finding[]> {
  const claim = parseAgentResultClaim(await context.sandbox.readFile("src/oz-result.json"));
  if (claim?.ok !== true) return [];
  const successProbeRuns = probeRuns.filter((run) => isSuccessProbe(run.probe));
  if (successProbeRuns.some((run) => run.failure === null)) return [];
  const evidenceLines = [
    "src/oz-result.json claims ok:true, but Kiln did not observe an independent success oracle for this scenario.",
    successProbeRuns.length === 0
      ? "No dynamic probe with verificationRole:'success' was configured."
      : `Configured success probes failed: ${successProbeRuns.map((run) => `${run.probe.name} -> HTTP ${run.status}`).join(", ")}.`,
    `Agent claim: ${JSON.stringify(claim)}`,
  ];
  return [
    makeFinding({
      context,
      code: "integration_success_unverified",
      title: "Agent-reported success was not independently verified",
      severity: "high",
      status: "unverified",
      canHardCap: true,
      evidence: [
        makeEvidence({
          type: "dynamic",
          replayCmd: "test -s src/oz-result.json && cat src/oz-result.json",
          excerpt: evidenceLines.join("\n"),
          observedAt: context.observedAt,
          artifactRefs: ["src/oz-result.json"],
        }),
      ],
    }),
  ];
}

function inferredWebhookUrls(context: StaticGraderContext): string[] {
  const urls = new Set<string>();
  for (const assertion of context.config.assertions) {
    if (assertion.type === "http" && "url" in assertion.config && /webhook/i.test(assertion.config.url)) {
      urls.add(assertion.config.url);
    }
  }
  if (sourceArtifacts(context.artifacts).some(sourceMentionsWebhook)) {
    urls.add("http://localhost:3000/webhook");
    urls.add("http://localhost:3000/api/webhook");
  }
  return [...urls];
}

function successfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function successBody(body: string): boolean {
  return /\b(ok|success|succeeded|created|accepted|processed)\b/i.test(body);
}

async function runWebhookForgeryProbe(context: StaticGraderContext): Promise<Finding[]> {
  if (!textSuggestsWebhook(contextText(context.config))) return [];
  for (const url of inferredWebhookUrls(context)) {
    const request: HttpRequest = {
      url,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kiln-forged-signature": "forged",
      },
      body: JSON.stringify({ id: "evt_kiln_forged", type: "payment_succeeded" }),
    };
    const result = await context.sandbox.httpRequest(request);
    if (result.status === 0 || !successfulStatus(result.status)) continue;
    return [
      makeFinding({
        context,
        code: "false_success_declaration",
        title: "Webhook endpoint accepts a forged unsigned payload",
        severity: "critical",
        evidence: [
          makeEvidence({
            type: "dynamic",
            replayCmd: replayFor(request),
            excerpt: `Forged webhook request returned HTTP ${result.status}.\n${result.body}`,
            observedAt: context.observedAt,
          }),
        ],
      }),
    ];
  }
  return [];
}

function inferredMalformedUrls(context: StaticGraderContext): string[] {
  const urls = new Set<string>();
  for (const assertion of context.config.assertions) {
    if (assertion.type === "http" && "url" in assertion.config && !/health/i.test(assertion.name)) {
      urls.add(assertion.config.url);
    }
  }
  if (sourceArtifacts(context.artifacts).some(sourceMentionsMoneyOrApi)) {
    urls.add("http://localhost:3000/checkout");
    urls.add("http://localhost:3000/api/checkout");
    urls.add("http://localhost:3000/payment-intents");
  }
  return [...urls];
}

async function runMalformedInputProbe(context: StaticGraderContext): Promise<Finding[]> {
  if (!textSuggestsInputValidation(contextText(context.config))) return [];
  for (const url of inferredMalformedUrls(context)) {
    const request: HttpRequest = {
      url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: -1, currency: "", __kilnMalformed: true }),
    };
    const result = await context.sandbox.httpRequest(request);
    if (result.status === 0) continue;
    if (successfulStatus(result.status) && successBody(result.body)) {
      return [
        makeFinding({
          context,
          code: "input_not_validated",
          title: "Malformed input is accepted as a successful request",
          severity: "high",
          canHardCap: false,
          evidence: [
            makeEvidence({
              type: "dynamic",
              replayCmd: replayFor(request),
              excerpt: `Malformed request returned HTTP ${result.status} with success-like body.\n${result.body}`,
              observedAt: context.observedAt,
            }),
          ],
        }),
      ];
    }
  }
  return [];
}

export async function runDynamicGraders(context: StaticGraderContext): Promise<Finding[]> {
  const configuredProbeRuns = await executeConfiguredProbes(context);
  const groups = await Promise.all([
    Promise.resolve(configuredProbeFindings(context, configuredProbeRuns)),
    runSuccessClaimVerifier(context, configuredProbeRuns),
    runWebhookForgeryProbe(context),
    runMalformedInputProbe(context),
  ]);
  return groups.flat();
}

export type { HttpMethod };
