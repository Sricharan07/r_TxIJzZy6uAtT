import type { OzAgentState, OzFrictionInsight, OzRecommendedFix, OzReport, RunResult } from "@kiln/shared";
import { analyzeRunFailure } from "./failure-analyst-agent.js";
import { analyzeFriction, behaviorSummaryFor } from "./friction-analyst-agent.js";

function frictionTarget(category: OzFrictionInsight["category"]): OzRecommendedFix["target"] {
  if (category === "auth") return "docs";
  if (category === "harness") return "tests";
  return category;
}

function recommendedFixes(
  state: OzAgentState,
  findings: ReturnType<typeof analyzeRunFailure>,
  frictionInsights: OzFrictionInsight[],
): OzRecommendedFix[] {
  const actionableFriction = frictionInsights.filter((insight) => insight.status !== "informational");
  if (findings.length === 0 && actionableFriction.length === 0) {
    return [{
      title: "Keep this suite as a regression check",
      detail: "The agent completed the generated suite. Re-run it when docs or SDK versions change.",
      target: "tests",
      evidence: state.productProfile?.evidence ?? [],
    }];
  }
  const findingFixes: OzRecommendedFix[] = findings.map((finding): OzRecommendedFix => ({
    title: `Address ${finding.code.replaceAll("_", " ")}`,
    detail:
      finding.code === "platform_timeout"
        ? "Increase or correctly propagate run timeouts through the sandbox and queue worker before interpreting this as product feedback."
        : finding.code === "agent_cli_failure"
          ? "Inspect the agent CLI trace and rerun after the harness can distinguish agent exits from product integration failures."
          : finding.code === "sandbox_failure"
            ? "Fix the sandbox transport or Firecracker host issue before treating this run as a product signal."
            : finding.code === "missing_required_env"
              ? "Collect the required credentials in the Oz run setup before executing live product workflows."
              : finding.code === "harness_issue"
                ? "Fix the generated assertions or grader precedence before treating this as product documentation feedback."
              : finding.code === "agent_secret_exposure"
                ? "Update the agent instructions or examples so credentials are checked by presence only and never echoed, logged, or written to artifacts."
                : finding.code === "auth_confusion"
        ? "Make credential names, auth headers, and local test credentials explicit in the quickstart."
        : finding.code === "sdk_mismatch"
          ? "Align code examples with the currently published SDK exports and add import/init snippets."
          : finding.code === "product_api_error"
            ? "Inspect the product API response and document the expected error handling or required request fields."
          : finding.code === "environment_issue"
            ? "Document runtime requirements and package native dependencies clearly."
            : "Clarify the docs around the failed workflow and add a minimal copy-pasteable example.",
    target: finding.code === "harness_issue"
      ? "tests"
      : finding.code === "agent_secret_exposure"
      ? "agent"
      : finding.code.startsWith("platform_") || finding.code === "agent_cli_failure" || finding.code === "sandbox_failure" || finding.code === "environment_issue"
      ? "environment"
      : finding.code === "sdk_mismatch"
        ? "sdk"
        : "docs",
    evidence: state.productProfile?.evidence ?? [],
  }));
  const frictionFixes: OzRecommendedFix[] = actionableFriction.map((insight): OzRecommendedFix => ({
    title: insight.title,
    detail: insight.recommendation,
    target: frictionTarget(insight.category),
    evidence: insight.docsEvidence,
  }));
  return [...findingFixes, ...frictionFixes]
    .filter((fix, index, all) => all.findIndex((item) => item.title === fix.title && item.target === fix.target) === index)
    .slice(0, 8);
}

export function buildOzReport(state: OzAgentState, runs: RunResult[]): OzReport {
  const evidence = state.productProfile?.evidence ?? [];
  const reportableRuns = runs.filter((run) => run.status !== "canceled");
  const rawFindings = reportableRuns.flatMap((run) => analyzeRunFailure(run, evidence));
  const findings = [...new Map(rawFindings.map((finding) => [finding.code, finding])).values()];
  const behaviorSummary = behaviorSummaryFor(reportableRuns);
  const frictionInsights = analyzeFriction(state, reportableRuns);
  const passed = reportableRuns.filter((run) =>
    run.status === "completed"
    && (run.gradeReport ? run.gradeReport.taskPassed : run.verdicts.every((verdict) => verdict.type === "llm" || verdict.passed))
  ).length;
  const platformFindings = findings.filter((finding) =>
    finding.code.startsWith("platform_") || finding.code === "agent_cli_failure" || finding.code === "sandbox_failure",
  ).length;
  const summary =
    runs.length > 0 && reportableRuns.length === 0
      ? "Oz stopped the run before completion. No product result was produced."
      : reportableRuns.length === 0
      ? "Oz generated an agent-readiness suite. No runs have completed yet."
      : platformFindings === findings.length && findings.length > 0
        ? `${passed}/${reportableRuns.length} agent run${reportableRuns.length === 1 ? "" : "s"} passed. The product result is inconclusive because the harness produced ${findings.length} platform finding${findings.length === 1 ? "" : "s"}.`
      : `${passed}/${reportableRuns.length} agent run${reportableRuns.length === 1 ? "" : "s"} passed. Oz produced ${findings.length} DX finding${findings.length === 1 ? "" : "s"}.`;
  return {
    summary,
    findings,
    behaviorSummary,
    frictionInsights,
    recommendedFixes: recommendedFixes(state, findings, frictionInsights),
  };
}
