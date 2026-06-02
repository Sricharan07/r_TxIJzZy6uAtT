/**
 * Codex agent adapter (Decision 3) — STUB / NOT YET IMPLEMENTED.
 *
 * This adapter is a placeholder so the registry can resolve `agentType: "codex"`
 * without crashing. The real implementation will drive the Codex CLI inside the
 * sandbox the same way {@link ClaudeCodeAgent} drives `claude`. Until then it
 * returns a minimal, clearly-labelled simulated stream and does no real work.
 */
import type { AgentEvent } from "@kiln/shared";
import type { Agent, AgentRun, AgentTask } from "./interface";

export class CodexAgent implements Agent {
  readonly type = "codex" as const;

  async startTask(task: AgentTask): Promise<AgentRun> {
    const head = task.prompt.split("\n", 1)[0]?.slice(0, 80) ?? "task";
    const events: AgentEvent[] = [
      {
        t: 0,
        kind: "info",
        text: `Codex adapter is not yet implemented. Goal: ${head}`,
        annotation: "Stub: returns a minimal simulated stream and performs no real work.",
      },
      { t: 8, kind: "warn", text: "Codex execution skipped (adapter stubbed)" },
    ];

    return {
      events,
      tokens: 0,
      steps: 0,
      async collectArtifacts(): Promise<void> {
        // Nothing to collect — the stub never mutates the sandbox.
      },
    };
  }
}
