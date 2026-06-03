/** Codex CLI adapter (Decision 3). */
import type { Agent, AgentRun, AgentTask } from "./interface.js";
import { runCliAgent, shellQuote } from "./cli.js";

export class CodexAgent implements Agent {
  readonly type = "codex" as const;

  async startTask(task: AgentTask): Promise<AgentRun> {
    return runCliAgent(task, {
      displayName: "Codex",
      binary: "codex",
      commandEnv: "KILN_CODEX_COMMAND",
      buildCommand: (prompt) =>
        `codex exec --json --sandbox danger-full-access --skip-git-repo-check ${shellQuote(prompt)}`,
    });
  }
}
