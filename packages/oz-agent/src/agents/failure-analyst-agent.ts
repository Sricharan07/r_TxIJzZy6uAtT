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
  | "environment_issue";

function classify(run: RunResult): FailureCode {
  const text = [
    run.errorType ?? "",
    ...run.events.map((event) => `${event.text} ${event.annotation ?? ""}`),
    ...run.verdicts.map((verdict) => `${verdict.name} ${verdict.output ?? ""} ${verdict.hint ?? ""}`),
  ].join("\n").toLowerCase();
  if (run.errorType === "timeout" || /command timed out|run exceeded .* timeout/.test(text)) return "platform_timeout";
  if (/missing required product environment variables/.test(text)) return "missing_required_env";
  if (/cli exited with code|agent cli|claude code cli|codex cli|cursor cli/.test(text)) return "agent_cli_failure";
  if (run.errorType === "platform" && /sandbox|firecracker|guest|ssh|manager unavailable|teardown/.test(text)) return "sandbox_failure";
  if (run.errorType === "platform" && run.verdicts.length === 0) return "agent_cli_failure";
  if (/missing.*env|credential|api key|unauthorized|forbidden|401|403/.test(text)) return "auth_confusion";
  if (/cannot find module|package|install|glibc|native binding/.test(text)) return "environment_issue";
  if (/not a function|does not export|undefined method|sdk/.test(text)) return "sdk_mismatch";
  if (/expected.*not found|missing docs|not documented/.test(text)) return "docs_missing";
  if (/ambiguous|conflicting|two names/.test(text)) return "docs_ambiguous";
  if (/test suite|assertion/.test(text)) return "test_suite_issue";
  if (/hallucinat|invent/.test(text)) return "agent_hallucination";
  return "docs_ambiguous";
}

function severityFor(run: RunResult): Severity {
  if (run.errorType) return "high";
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
