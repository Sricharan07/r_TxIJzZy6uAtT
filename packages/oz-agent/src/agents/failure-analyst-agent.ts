import type { Finding, OzEvidence, RunResult, Severity } from "@kiln/shared";

type FailureCode =
  | "platform_timeout"
  | "agent_cli_failure"
  | "sandbox_failure"
  | "missing_required_env"
  | "docs_missing"
  | "docs_ambiguous"
  | "sdk_mismatch"
  | "outdated_example"
  | "auth_confusion"
  | "agent_hallucination"
  | "test_suite_issue"
  | "environment_issue"
  | "product_api_error"
  | "harness_issue";

function runText(run: RunResult): string {
  return [
    run.errorType ?? "",
    ...run.events.map((event) => `${event.text} ${event.annotation ?? ""}`),
    ...run.verdicts.map((verdict) => `${verdict.name} ${verdict.output ?? ""} ${verdict.hint ?? ""}`),
    run.gradeReport ? JSON.stringify(run.gradeReport.findings.map((finding) => ({ code: finding.code, title: finding.title, status: finding.status }))) : "",
  ].join("\n").toLowerCase();
}

function runtimeSucceeded(run: RunResult, text: string): boolean {
  if (run.gradeReport?.taskPassed) return true;
  const deterministic = run.verdicts.filter((verdict) => verdict.type !== "llm");
  const projectCommandPassed = deterministic.some((verdict) => /project command succeeds/i.test(verdict.name) && verdict.passed);
  const resultContractPassed = deterministic.some((verdict) => /result (contract|artifact)/i.test(verdict.name) && verdict.passed);
  const explicitSuccess = /\bhttp\s*200\b|\bhttpstatus["']?\s*[:=]\s*200\b|\bstatus["']?\s*[:=]\s*200\b|response \(http 200\)|"ok"\s*:\s*true/.test(text);
  return run.status === "completed" && projectCommandPassed && resultContractPassed && explicitSuccess;
}

function failedOnlyAdvisoryOrPatternChecks(run: RunResult): boolean {
  const failedFindings = run.gradeReport?.findings.filter((finding) => finding.status === "confirmed") ?? [];
  if (failedFindings.length === 0) return false;
  return failedFindings.every((finding) =>
    finding.code === "documented_surface_not_referenced" ||
    finding.code === "llm_judge_advisory" ||
    (finding.code === "assertion_command_failed" && /documented product surface/i.test(finding.title))
  );
}

function classify(run: RunResult): FailureCode {
  const text = runText(run);
  if (run.errorType === "timeout" || /command timed out|run exceeded .* timeout/.test(text)) return "platform_timeout";
  if (/missing required product environment variables/.test(text)) return "missing_required_env";
  if (run.errorType === "platform" && /sandbox|firecracker|guest|ssh|manager unavailable|teardown/.test(text)) return "sandbox_failure";
  if (runtimeSucceeded(run, text) && failedOnlyAdvisoryOrPatternChecks(run)) return "harness_issue";
  if (/cannot find module|package|install|glibc|native binding|product (setup|preflight) step/.test(text)) return "environment_issue";
  if (/not a function|does not export|undefined method|sdk/.test(text)) return "sdk_mismatch";
  if (/cli exited with code|agent cli|claude code cli|codex cli|cursor cli/.test(text)) return "agent_cli_failure";
  if (run.errorType === "platform" && run.verdicts.length === 0) return "agent_cli_failure";
  if (/unauthorized|forbidden|\b401\b|\b403\b|invalid (api key|token|credential)|missing (api key|token|credential)|authentication failed|wrong auth/.test(text)) return "auth_confusion";
  if (/\b4\d\d\b|\b5\d\d\b|rate limit|quota|bad request|unprocessable/.test(text)) return "product_api_error";
  if (/expected.*not found|missing docs|not documented/.test(text)) return "docs_missing";
  if (/ambiguous|conflicting|two names/.test(text)) return "docs_ambiguous";
  if (/test suite|assertion/.test(text)) return "test_suite_issue";
  if (/hallucinat|invent/.test(text)) return "agent_hallucination";
  return "docs_ambiguous";
}

function severityFor(run: RunResult): Severity {
  if (run.errorType) return "high";
  if (classify(run) === "harness_issue") return "medium";
  if (run.verdicts.some((verdict) => !verdict.passed && verdict.type !== "llm")) return "high";
  return "medium";
}

export function analyzeRunFailure(run: RunResult, evidence: OzEvidence[]): Finding[] {
  const failed = run.status === "errored"
    || (run.gradeReport ? !run.gradeReport.taskPassed : run.verdicts.some((verdict) => !verdict.passed && verdict.type !== "llm"));
  if (!failed) return [];
  const code = classify(run);
  return [
    {
      id: `${run.id}:oz:${code}`,
      runId: run.id,
      taskSpecId: run.gradeReport?.taskSpecId ?? "oz_agentic_suite",
      code,
      title: `Oz classified failure as ${code.replaceAll("_", " ")}`,
      severity: severityFor(run),
      status: "confirmed",
      canHardCap: false,
      evidence: evidence.map((item) => ({
        type: "trace",
        confidence: item.confidence,
        replayCmd: `open report ${run.id}`,
        redactionStatus: "clean",
        customerExcerpt: item.quote,
        observedAt: new Date().toISOString(),
        artifactRefs: [item.source],
      })),
      codeVsNoCode: "mixed",
    },
  ];
}
