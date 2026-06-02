/**
 * @kiln/grader public API (Decision 5 grading; Decision 16 assertion types).
 *
 * Grades a finished sandbox against a list of assertions and returns verdicts.
 */
export type { SandboxHandle, ExecResult, HttpResult } from "./sandbox";
export type { LlmJudge } from "./assertions/llm-judge";
export { HeuristicJudge, runLlmAssertion } from "./assertions/llm-judge";
export { runShellAssertion } from "./assertions/shell";
export { runHttpAssertion } from "./assertions/http";
export { runFileAssertion } from "./assertions/file";
export { grade } from "./grader";
