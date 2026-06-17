import type { EvalConfig, OzScenario } from "@kiln/shared";
import type { OzTool } from "./contracts.js";

interface RunSandboxCheckInput {
  evalConfig: EvalConfig;
  scenario: OzScenario;
}

export const runSandboxCheckTool: OzTool<RunSandboxCheckInput, { runnable: boolean; issues: string[] }> = {
  name: "run_sandbox_check",
  description: "Check whether a generated scenario is structurally runnable by the Kiln runner.",
  inputSchema: { type: "object", required: ["evalConfig", "scenario"] },
  outputSchema: { type: "object" },
  async execute(input) {
    const issues: string[] = [];
    if (input.evalConfig.assertions.length === 0) issues.push("Scenario has no assertions.");
    if (input.evalConfig.metadata.timeoutSec <= 0) issues.push("Timeout must be positive.");
    if (input.evalConfig.productProfile?.requiredEnv?.some((env) => env.scopes.length === 0)) {
      issues.push("A required environment variable has no exposure scopes.");
    }
    for (const assertion of input.evalConfig.assertions) {
      if (assertion.type === "shell" && !("command" in assertion.config)) issues.push(`${assertion.name}: shell command missing.`);
      if (assertion.type === "file" && !("path" in assertion.config)) issues.push(`${assertion.name}: file path missing.`);
      if (assertion.type === "http" && !("url" in assertion.config)) issues.push(`${assertion.name}: HTTP URL missing.`);
    }
    return { runnable: issues.length === 0, issues };
  },
};
