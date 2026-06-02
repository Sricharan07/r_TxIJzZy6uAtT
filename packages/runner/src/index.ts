/**
 * @kiln/runner — barrel.
 *
 * The agent-execution service (Decision 1): provisions Firecracker sandboxes
 * (Decision 2), drives pluggable agents (Decision 3), ingests context
 * (Decision 15), streams events (Decision 11), and hands finished sandboxes to
 * the grader (Decision 5).
 */
export type { Agent, AgentTask, AgentRun } from "./agents/interface";
export { getAgent } from "./agents/registry";
export { ClaudeCodeAgent } from "./agents/claude-code";
export { CodexAgent } from "./agents/codex";
export { FirecrackerSandbox } from "./sandbox/firecracker";
export { crawlUrl } from "./context/crawler";
export { cloneRepo } from "./context/github";
export { executeRun, startWorker } from "./worker";
