import type {
  AgentModelGrade,
  Assertion,
  AssertionType,
  CodeVsNoCode,
  EvalConfig,
  EvidenceType,
  Finding,
  GradeReport,
  GraderEvidence,
  GraderKind,
  GraderSpec,
  Severity,
  TaskSpec,
  Verdict,
} from "@kiln/shared";
import { computeGradeScore, definitionChecksFor } from "@kiln/shared";

const MAX_EXCERPT = 1_600;

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function firstLine(text: string): string {
  const first = text.split("\n", 1)[0]?.trim() || "Untitled task";
  return first.length > 80 ? first.slice(0, 77) + "..." : first;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertionKind(type: AssertionType): GraderKind {
  return type === "llm" ? "judge" : "deterministic";
}

function evidenceType(type: AssertionType): EvidenceType {
  return type === "llm" ? "judge" : "deterministic";
}

function defaultSeverity(type: AssertionType): Severity {
  return type === "llm" ? "medium" : "high";
}

function defaultFindingCode(type: AssertionType): string {
  switch (type) {
    case "shell":
      return "assertion_command_failed";
    case "http":
      return "http_assertion_failed";
    case "file":
      return "expected_artifact_missing";
    case "llm":
      return "llm_judge_advisory";
  }
}

function defaultCodeVsNoCode(type: AssertionType): CodeVsNoCode {
  return type === "llm" ? "mixed" : "code";
}

function replayCommand(assertion: Assertion): string {
  switch (assertion.type) {
    case "shell":
      return "command" in assertion.config ? assertion.config.command : "true";
    case "http":
      return "url" in assertion.config ? `curl -i ${shellQuote(assertion.config.url)}` : "true";
    case "file":
      if (!("path" in assertion.config)) return "true";
      return assertion.config.contains
        ? `grep -F -- ${shellQuote(assertion.config.contains)} ${shellQuote(assertion.config.path)}`
        : `test -f ${shellQuote(assertion.config.path)}`;
    case "llm":
      return "test -f README.md && sed -n '1,160p' README.md";
  }
}

function redactAndClip(raw: string): { text: string; redacted: boolean } {
  const patterns = [
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]{8,}/gi,
  ];
  let text = raw;
  let redacted = false;
  for (const pattern of patterns) {
    text = text.replace(pattern, () => {
      redacted = true;
      return "[REDACTED]";
    });
  }
  if (text.length > MAX_EXCERPT) {
    text = text.slice(0, MAX_EXCERPT) + "\n[truncated]";
  }
  return { text, redacted };
}

function verdictExcerpt(verdict: Verdict): { text: string; redacted: boolean } {
  const raw = [verdict.hint, verdict.output].filter(Boolean).join("\n\n") || "Assertion passed.";
  return redactAndClip(raw);
}

function toGraderSpec(assertion: Assertion, index: number): GraderSpec {
  return {
    id: assertion.id ?? `assertion-${index}`,
    kind: assertionKind(assertion.type),
    name: assertion.name,
    required: assertion.type !== "llm",
    severityOnFail: assertion.severityOnFail ?? defaultSeverity(assertion.type),
    frictionCode: assertion.frictionCode ?? defaultFindingCode(assertion.type),
    replayCmdTemplate: replayCommand(assertion),
  };
}

export function taskSpecFromEvalConfig(config: EvalConfig): TaskSpec {
  return {
    id: `task_${hash(config.task + "|" + config.language)}`,
    title: firstLine(config.task),
    mode: "integration-build",
    lane: "A",
    prompt: config.task,
    contextRefs: config.context.map((source) => source.label),
    agentTypes: [config.metadata.agentType],
    modelIds: [config.metadata.modelId ?? "unknown"],
    n: config.metadata.requestedRuns ?? 1,
    weight: 1,
    oracle: {
      expectedEndState: {
        assertions: config.assertions.map((assertion) => ({
          type: assertion.type,
          name: assertion.name,
          config: assertion.config,
        })),
      },
    },
    requiredGraders: config.assertions.map(toGraderSpec),
    staticGraders: [],
    dynamicGraders: (config.dynamicProbes ?? []).map((probe, index) => ({
      id: probe.id ?? `dynamic-${index}`,
      kind: "dynamic",
      name: probe.name,
      required: true,
      severityOnFail: probe.severityOnFail ?? "high",
      frictionCode: probe.codeOnFail ?? "dynamic_probe_failed",
      replayCmdTemplate: `${probe.method ?? "GET"} ${probe.url}`,
    })),
    tags: [`language:${config.language}`, "slice-1"],
  };
}

export function evidenceForVerdict(
  verdict: Verdict,
  assertion: Assertion,
  observedAt: string,
): GraderEvidence {
  const excerpt = verdictExcerpt(verdict);
  return {
    type: evidenceType(assertion.type),
    confidence: assertion.type === "llm" ? 0.45 : 1,
    replayCmd: replayCommand(assertion),
    redactionStatus: excerpt.redacted ? "redacted" : "clean",
    customerExcerpt: excerpt.text,
    observedAt,
  };
}

export function attachVerdictEvidence(
  verdict: Verdict,
  assertion: Assertion,
  observedAt: string,
): Verdict {
  return {
    ...verdict,
    evidence: [evidenceForVerdict(verdict, assertion, observedAt)],
  };
}

function findingFromFailedVerdict(
  runId: string,
  taskSpecId: string,
  verdict: Verdict,
  assertion: Assertion,
): Finding {
  const severity = assertion.severityOnFail ?? defaultSeverity(assertion.type);
  const isAdvisory = assertion.type === "llm";
  const canHardCap = !isAdvisory && (assertion.canHardCap === true || severity === "critical");
  return {
    id: `${runId}:finding:${verdict.assertionIndex}`,
    runId,
    taskSpecId,
    code: assertion.frictionCode ?? defaultFindingCode(assertion.type),
    title: verdict.name,
    severity,
    status: isAdvisory ? "advisory" : "confirmed",
    canHardCap,
    hardCapGrade: canHardCap ? assertion.hardCapGrade ?? "C-" : undefined,
    evidence: verdict.evidence ?? [],
    codeVsNoCode: assertion.codeVsNoCode ?? defaultCodeVsNoCode(assertion.type),
  };
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const severityDelta = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDelta !== 0) return severityDelta;
    if (a.status !== b.status) return a.status === "confirmed" ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

function remediationProjection(findings: Finding[]): GradeReport["remediationProjection"] {
  const confirmed = findings.filter((finding) => finding.status === "confirmed");
  if (confirmed.length === 0) return undefined;
  return {
    score: 100,
    letter: "A+",
    summary: `Fixing ${confirmed.length} confirmed finding${
      confirmed.length === 1 ? "" : "s"
    } would project this task to A+ if all deterministic assertions then pass.`,
  };
}

export function buildGradeReport({
  runId,
  config,
  verdicts,
  generatedAt,
  taskSpec,
  staticFindings = [],
  dynamicFindings = [],
  traceFindings = [],
  traceMetrics,
}: {
  runId: string;
  config: EvalConfig;
  verdicts: Verdict[];
  generatedAt: string;
  taskSpec?: TaskSpec;
  staticFindings?: Finding[];
  dynamicFindings?: Finding[];
  traceFindings?: Finding[];
  traceMetrics?: GradeReport["traceMetrics"];
}): GradeReport {
  const resolvedTaskSpec = taskSpec ?? config.taskSpec ?? taskSpecFromEvalConfig(config);
  const findings = sortFindings(
    [
      ...verdicts
        .filter((verdict) => !verdict.passed)
        .map((verdict) =>
          findingFromFailedVerdict(
            runId,
            resolvedTaskSpec.id,
            verdict,
            config.assertions[verdict.assertionIndex]!,
          ),
        ),
      ...staticFindings,
      ...dynamicFindings,
      ...traceFindings,
    ],
  );
  const taskPassed = findings.every((finding) => finding.status !== "confirmed");
  const runs = 1;
  const passedRuns = taskPassed ? 1 : 0;
  const score = computeGradeScore({ passedRuns, runs, findings });
  const agentMatrix: AgentModelGrade[] = [
    {
      agentType: config.metadata.agentType,
      modelId: config.metadata.modelId ?? "unknown",
      runs,
      passedRuns,
      passRate: score.passRate,
    },
  ];

  const report: GradeReport = {
    runId,
    taskSpecId: resolvedTaskSpec.id,
    mode: resolvedTaskSpec.mode,
    buildPhase: "slice-1",
    taskPassed,
    score,
    findings,
    agentMatrix,
    traceMetrics,
    definitionOfDone: [],
    generatedAt,
    remediationProjection: remediationProjection(findings),
  };
  return { ...report, definitionOfDone: definitionChecksFor(report) };
}
