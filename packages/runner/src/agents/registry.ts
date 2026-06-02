/**
 * Agent registry (Decision 3).
 *
 * Maps an {@link AgentType} to its adapter instance. This is the single place
 * the runner resolves which adapter to drive, keeping the worker fully
 * agent-agnostic. Adding a new agent = add an adapter + one line here.
 */
import type { AgentType } from "@kiln/shared";
import type { Agent } from "./interface.js";
import { ClaudeCodeAgent } from "./claude-code.js";
import { CodexAgent } from "./codex.js";

const claudeCode = new ClaudeCodeAgent();
const codex = new CodexAgent();

/**
 * Resolve the adapter for `type`.
 *
 * @throws if the agent type has no adapter yet (e.g. "cursor", which is planned
 * but unimplemented). Callers should surface this as a `platform` error.
 */
export function getAgent(type: AgentType): Agent {
  switch (type) {
    case "claude-code":
      return claudeCode;
    case "codex":
      return codex;
    case "cursor":
      throw new Error(`No agent adapter registered for "${type}" (not yet implemented).`);
    default: {
      // Exhaustiveness guard: if AgentType gains a member, this won't compile.
      const _exhaustive: never = type;
      throw new Error(`Unknown agent type: ${String(_exhaustive)}`);
    }
  }
}
