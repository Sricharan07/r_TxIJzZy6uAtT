/** Cursor CLI adapter (Decision 3). */
import type { Agent, AgentRun, AgentTask } from "./interface.js";
import { runCliAgent, shellQuote } from "./cli.js";

export class CursorAgent implements Agent {
  readonly type = "cursor" as const;

  async startTask(task: AgentTask): Promise<AgentRun> {
    return runCliAgent(task, {
      displayName: "Cursor",
      binary: "agent",
      commandEnv: "KILN_CURSOR_COMMAND",
      buildCommand: (prompt) =>
        `agent -p ${shellQuote(prompt)} --force --output-format stream-json --stream-partial-output`,
    });
  }
}
