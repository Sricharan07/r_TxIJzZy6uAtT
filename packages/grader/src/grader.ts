/**
 * Grader dispatch (Decision 5 grading; Decision 16 assertion types).
 *
 * Runs every assertion against a finished sandbox and returns one verdict per
 * assertion, preserving order. Assertion implementations return verdicts for
 * logical failures. Transport exceptions propagate so the runner can classify
 * them as platform failures rather than blaming the evaluated integration.
 */
import type { Assertion, Verdict } from "@kiln/shared";
import type { SandboxHandle } from "./sandbox.js";
import { runShellAssertion } from "./assertions/shell.js";
import { runHttpAssertion } from "./assertions/http.js";
import { runFileAssertion } from "./assertions/file.js";
import { runLlmAssertion, type LlmJudge } from "./assertions/llm-judge.js";

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
  for (let idx = 0; idx < assertions.length; idx++) {
    const assertion = assertions[idx]!;
    verdicts.push(await gradeOne(assertion, idx, sandbox, judge));
  }
  return verdicts;
}
