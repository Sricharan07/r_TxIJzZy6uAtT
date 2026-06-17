import type { OzAgentState, OzRecommendedFix, OzReport, RunResult } from "@kiln/shared";
import { analyzeRunFailure } from "./failure-analyst-agent.js";

function recommendedFixes(state: OzAgentState, findings: ReturnType<typeof analyzeRunFailure>): OzRecommendedFix[] {
  if (findings.length === 0) {
    return [{
      title: "Keep this suite as a regression check",
      detail: "The agent completed the generated suite. Re-run it when docs or SDK versions change.",
      target: "tests",
      evidence: state.productProfile?.evidence ?? [],
    }];
  }
  return findings.map((finding) => ({
    title: `Address ${finding.code.replaceAll("_", " ")}`,
    detail:
      finding.code === "auth_confusion"
        ? "Make credential names, auth headers, and local test credentials explicit in the quickstart."
        : finding.code === "sdk_mismatch"
          ? "Align code examples with the currently published SDK exports and add import/init snippets."
          : finding.code === "environment_issue"
            ? "Document runtime requirements and package native dependencies clearly."
            : "Clarify the docs around the failed workflow and add a minimal copy-pasteable example.",
    target: finding.code === "environment_issue" ? "environment" : finding.code === "sdk_mismatch" ? "sdk" : "docs",
    evidence: state.productProfile?.evidence ?? [],
  }));
}

export function buildOzReport(state: OzAgentState, runs: RunResult[]): OzReport {
  const evidence = state.productProfile?.evidence ?? [];
  const findings = runs.flatMap((run) => analyzeRunFailure(run, evidence));
  const passed = runs.filter((run) => run.status === "completed" && run.verdicts.every((verdict) => verdict.passed)).length;
  const summary =
    runs.length === 0
      ? "Oz generated an agent-readiness suite. No runs have completed yet."
      : `${passed}/${runs.length} agent run${runs.length === 1 ? "" : "s"} passed. Oz produced ${findings.length} DX finding${findings.length === 1 ? "" : "s"}.`;
  return {
    summary,
    findings,
    recommendedFixes: recommendedFixes(state, findings),
  };
}
