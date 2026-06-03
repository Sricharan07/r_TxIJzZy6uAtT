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
import { CursorAgent } from "./cursor.js";

const claudeCode = new ClaudeCodeAgent();
const codex = new CodexAgent();
const cursor = new CursorAgent();

/**
 * Resolve the adapter for `type`.
 *
 * @throws if the agent type is unknown. Callers surface adapter failures as a
 * `platform` error.
 */
export function getAgent(type: AgentType): Agent {
  switch (type) {
    case "claude-code":
      return claudeCode;
    case "codex":
      return codex;
    case "cursor":
      return cursor;
    default: {
      // Exhaustiveness guard: if AgentType gains a member, this won't compile.
      const _exhaustive: never = type;
      throw new Error(`Unknown agent type: ${String(_exhaustive)}`);
    }
  }
}
