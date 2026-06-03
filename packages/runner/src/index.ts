/**
 * @kiln/runner — barrel.
 *
 * The agent-execution service (Decision 1): provisions Firecracker sandboxes
 * (Decision 2), drives pluggable agents (Decision 3), ingests context
 * (Decision 15), streams events (Decision 11), and hands finished sandboxes to
 * the grader (Decision 5).
 */
export type { Agent, AgentTask, AgentRun } from "./agents/interface.js";
export { getAgent } from "./agents/registry.js";
export { ClaudeCodeAgent } from "./agents/claude-code.js";
export { CodexAgent } from "./agents/codex.js";
export { CursorAgent } from "./agents/cursor.js";
export { createSandbox, FirecrackerSandbox, LocalSandbox } from "./sandbox/firecracker.js";
export { createHostManagerServer, ProcessFirecrackerDriver, startHostManager } from "./sandbox/host-manager.js";
export { crawlUrl } from "./context/crawler.js";
export { cloneRepo } from "./context/github.js";
export { executeRun, startWorker } from "./worker.js";
