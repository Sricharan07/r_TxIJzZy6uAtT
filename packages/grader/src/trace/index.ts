import type { AgentEvent, Finding, TraceMetrics } from "@kiln/shared";
import { makeEvidence, makeFinding, type StaticGraderContext } from "../static/shared.js";

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function repeatedErrorCount(events: AgentEvent[]): number {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "fail" && event.kind !== "warn") continue;
    const key = normalize(event.annotation ?? event.text);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function retryCount(events: AgentEvent[]): number {
  return events.filter((event) => /\b(retry|retried|again|re-read|read .* times)\b/i.test(event.text)).length;
}

function humanRescueCount(events: AgentEvent[]): number {
  return events.filter((event) => /\b(human|manual intervention|asked user|user supplied)\b/i.test(event.text)).length;
}

function apiErrorCount(events: AgentEvent[]): number {
  return events.filter((event) => /\b(4\d\d|5\d\d|not found|unauthorized|forbidden|rate limit)\b/i.test(event.text)).length;
}

function sdkDiscoveryEvents(events: AgentEvent[]): number {
  return events.filter((event) => /\b(sdk|package|npm install|pip install|docs|quickstart)\b/i.test(event.text)).length;
}

function handRolledIndicators(events: AgentEvent[]): number {
  return events.filter((event) => /\b(hand.?roll|manual|without sdk|raw http|from scratch)\b/i.test(event.text)).length;
}

export function traceMetricsFor({
  events,
  durationSec,
  totalSteps,
  tokens,
}: {
  events: AgentEvent[];
  durationSec: number;
  totalSteps: number;
  tokens: number;
}): TraceMetrics {
  return {
    durationSec,
    totalSteps,
    tokens,
    retryCount: retryCount(events),
    loopOnSameErrorCount: repeatedErrorCount(events),
    humanRescueCount: humanRescueCount(events),
    apiErrorCount: apiErrorCount(events),
    sdkDiscoveryEvents: sdkDiscoveryEvents(events),
    handRolledIndicators: handRolledIndicators(events),
  };
}

export function runTraceGraders(
  context: StaticGraderContext,
  events: AgentEvent[],
): Finding[] {
  const findings: Finding[] = [];
  const loopCount = repeatedErrorCount(events);
  if (loopCount >= 3) {
    const repeated = events
      .filter((event) => event.kind === "fail" || event.kind === "warn")
      .map((event) => event.annotation ?? event.text)
      .find(Boolean) ?? "Repeated failure";
    findings.push(
      makeFinding({
        context,
        code: "loop_on_same_error",
        title: "Agent looped on the same error",
        severity: "medium",
        canHardCap: false,
        evidence: [
          makeEvidence({
            type: "trace",
            replayCmd: "grep -Ei 'fail|warn|error|gave up|loop' trace.json",
            excerpt: `${loopCount} repeated fail/warn events. Example: ${repeated}`,
            observedAt: context.observedAt,
          }),
        ],
      }),
    );
  }

  const metrics = traceMetricsFor({ events, durationSec: 0, totalSteps: events.length, tokens: 0 });
  if (metrics.handRolledIndicators > 0 && metrics.sdkDiscoveryEvents === 0) {
    findings.push(
      makeFinding({
        context,
        code: "sdk_not_discovered",
        title: "Trace suggests hand-rolled integration without SDK discovery",
        severity: "medium",
        canHardCap: false,
        evidence: [
          makeEvidence({
            type: "trace",
            replayCmd: "grep -Ei 'hand.?roll|manual|without sdk|raw http|from scratch' trace.json",
            excerpt: "Trace contains hand-rolled/manual integration signals and no SDK/package discovery events.",
            observedAt: context.observedAt,
          }),
        ],
      }),
    );
  }

  if (metrics.apiErrorCount >= 2 && metrics.retryCount === 0) {
    findings.push(
      makeFinding({
        context,
        code: "poor_error_handling",
        title: "API errors were observed without retry or recovery behavior",
        severity: "medium",
        canHardCap: false,
        evidence: [
          makeEvidence({
            type: "trace",
            replayCmd: "grep -Ei '4[0-9][0-9]|5[0-9][0-9]|not found|unauthorized|forbidden|rate limit|retry' trace.json",
            excerpt: `${metrics.apiErrorCount} API-error event(s), ${metrics.retryCount} retry event(s).`,
            observedAt: context.observedAt,
          }),
        ],
      }),
    );
  }

  return findings;
}
