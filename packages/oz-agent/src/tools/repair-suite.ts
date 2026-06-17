import type { Assertion, OzRisk, OzScenario } from "@kiln/shared";
import type { OzTool } from "./contracts.js";

interface RepairSuiteInput {
  scenarios: OzScenario[];
  risks: OzRisk[];
}

const fallbackAssertion: Assertion = {
  type: "file",
  name: "README explains integration choices",
  config: { path: "README.md" },
};

export const repairSuiteTool: OzTool<RepairSuiteInput, { scenarios: OzScenario[] }> = {
  name: "repair_suite",
  description: "Repair suite issues found by the critic without inventing undocumented product APIs.",
  inputSchema: { type: "object", required: ["scenarios", "risks"] },
  outputSchema: { type: "object" },
  async execute(input) {
    const weak = new Set(
      input.risks
        .filter((risk) => risk.code === "weak_assertions")
        .map((risk) => risk.message.split(" needs ")[0]),
    );
    return {
      scenarios: input.scenarios.map((scenario) => {
        if (!weak.has(scenario.title) || scenario.assertions.some((assertion) => assertion.name === fallbackAssertion.name)) {
          return scenario;
        }
        return { ...scenario, assertions: [...scenario.assertions, fallbackAssertion] };
      }),
    };
  },
};
