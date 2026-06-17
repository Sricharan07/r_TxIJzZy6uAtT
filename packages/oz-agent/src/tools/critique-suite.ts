import type { OzRisk, OzScenario, Severity } from "@kiln/shared";
import { evidence, type OzTool } from "./contracts.js";

interface CritiqueSuiteInput {
  scenarios: OzScenario[];
}

function risk(code: string, severity: Severity, message: string): OzRisk {
  return { code, severity, message, evidence: [evidence("suite-critic", message, 0.82)] };
}

export const critiqueSuiteTool: OzTool<CritiqueSuiteInput, { risks: OzRisk[] }> = {
  name: "critique_suite",
  description: "Attack generated scenarios for vagueness, weak assertions, hallucination, and low DevRel usefulness.",
  inputSchema: { type: "object", required: ["scenarios"] },
  outputSchema: { type: "object" },
  async execute(input) {
    const risks: OzRisk[] = [];
    for (const scenario of input.scenarios) {
      if (scenario.assertions.length < 2) {
        risks.push(risk("weak_assertions", "medium", `${scenario.title} needs at least two deterministic assertions.`));
      }
      if (scenario.sources.length === 0) {
        risks.push(risk("missing_evidence", "medium", `${scenario.title} has no source evidence.`));
      }
      if (/\blooks good\b|\bmake something\b/i.test(scenario.task)) {
        risks.push(risk("vague_task", "high", `${scenario.title} task is too vague for an agent-readiness eval.`));
      }
    }
    return { risks };
  },
};
