/**
 * Grader dispatch (Decision 5 grading; Decision 16 assertion types).
 *
 * Runs every assertion against a finished sandbox and returns one verdict per
 * assertion, preserving order. Assertion implementations return verdicts for
 * logical failures. Transport exceptions propagate so the runner can classify
 * them as platform failures rather than blaming the evaluated integration.
 */
import type { AgentEvent, Assertion, EvalConfig, GradeReport, TraceMetrics, Verdict } from "@kiln/shared";
import type { SandboxHandle } from "./sandbox.js";
import { runShellAssertion } from "./assertions/shell.js";
import { runHttpAssertion } from "./assertions/http.js";
import { runFileAssertion } from "./assertions/file.js";
import { runLlmAssertion, type LlmJudge } from "./assertions/llm-judge.js";
import { attachVerdictEvidence, buildGradeReport, taskSpecFromEvalConfig } from "./report.js";
import { runDynamicGraders } from "./dynamic/index.js";
import { collectStaticArtifacts, runStaticGraders } from "./static/index.js";
import { runTraceGraders, traceMetricsFor } from "./trace/index.js";

import type {
  ShellAssertion,
  HttpAssertion,
  FileAssertion,
  LlmAssertion,
} from "@kiln/shared";

async function gradeOne(
  assertion: Assertion,
  idx: number,
  sandbox: SandboxHandle,
  judge?: LlmJudge,
): Promise<Verdict> {
  switch (assertion.type) {
    case "shell":
      return runShellAssertion(assertion.config as ShellAssertion, assertion.name, idx, sandbox);
    case "http":
      return runHttpAssertion(assertion.config as HttpAssertion, assertion.name, idx, sandbox);
    case "file":
      return runFileAssertion(assertion.config as FileAssertion, assertion.name, idx, sandbox);
    case "llm":
      return runLlmAssertion(
        assertion.config as LlmAssertion,
        assertion.name,
        idx,
        sandbox,
        judge,
      );
  }
}

export async function grade(
  assertions: Assertion[],
  sandbox: SandboxHandle,
  judge?: LlmJudge,
): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  const observedAt = new Date().toISOString();
  for (let idx = 0; idx < assertions.length; idx++) {
    const assertion = assertions[idx]!;
    const verdict = await gradeOne(assertion, idx, sandbox, judge);
    verdicts.push(attachVerdictEvidence(verdict, assertion, observedAt));
  }
  return verdicts;
}

export async function gradeWithReport(
  config: EvalConfig,
  sandbox: SandboxHandle,
  options: {
    runId: string;
    judge?: LlmJudge;
    generatedAt?: string;
    events?: AgentEvent[];
    runStats?: { durationSec: number; totalSteps: number; tokens: number };
  },
): Promise<{ verdicts: Verdict[]; gradeReport: GradeReport }> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const taskSpec = config.taskSpec ?? taskSpecFromEvalConfig(config);
  const verdicts: Verdict[] = [];
  for (let idx = 0; idx < config.assertions.length; idx++) {
    const assertion = config.assertions[idx]!;
    const verdict = await gradeOne(assertion, idx, sandbox, options.judge);
    verdicts.push(attachVerdictEvidence(verdict, assertion, generatedAt));
  }
  const artifacts = await collectStaticArtifacts(config, sandbox);
  const graderContext = {
    runId: options.runId,
    taskSpecId: taskSpec.id,
    config,
    sandbox,
    artifacts,
    observedAt: generatedAt,
  };
  const staticFindings = await runStaticGraders({
    runId: options.runId,
    taskSpecId: taskSpec.id,
    config,
    sandbox,
    observedAt: generatedAt,
    artifacts,
  });
  const dynamicFindings = await runDynamicGraders(graderContext);
  const events = options.events ?? [];
  const traceFindings = runTraceGraders(graderContext, events);
  const stats = options.runStats ?? { durationSec: 0, totalSteps: events.length, tokens: 0 };
  const traceMetrics: TraceMetrics = traceMetricsFor({
    events,
    durationSec: stats.durationSec,
    totalSteps: stats.totalSteps,
    tokens: stats.tokens,
  });
  return {
    verdicts,
    gradeReport: buildGradeReport({
      runId: options.runId,
      config,
      verdicts,
      generatedAt,
      taskSpec,
      staticFindings,
      dynamicFindings,
      traceFindings,
      traceMetrics,
    }),
  };
}
