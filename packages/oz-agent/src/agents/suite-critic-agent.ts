import type { OzAgentState } from "@kiln/shared";
import { critiqueSuiteTool } from "../tools/critique-suite.js";
import { repairSuiteTool } from "../tools/repair-suite.js";
import { runSandboxCheckTool } from "../tools/run-sandbox-check.js";
import { verifySuiteTool } from "../tools/verify-suite.js";
import { scenarioToEvalConfig } from "../eval-config.js";
import type { OzToolContext } from "../tools/contracts.js";

export async function runSuiteCriticAgent(state: OzAgentState, ctx: OzToolContext): Promise<OzAgentState> {
  if (!state.productProfile || !state.suiteDraft) {
    throw new Error("Product profile and suite draft are required before critique.");
  }
  const critique = await critiqueSuiteTool.execute({ scenarios: state.suiteDraft.scenarios }, ctx);
  const repaired = await repairSuiteTool.execute({ scenarios: state.suiteDraft.scenarios, risks: critique.risks }, ctx);
  const verification = await verifySuiteTool.execute(
    { profile: state.productProfile, scenarios: repaired.scenarios },
    ctx,
  );
  const sandboxChecks = await Promise.all(
    repaired.scenarios.map((scenario) =>
      runSandboxCheckTool.execute({ evalConfig: scenarioToEvalConfig({ state, scenario }), scenario }, ctx),
    ),
  );
  const sandboxIssues = sandboxChecks.flatMap((check, index) =>
    check.issues.map((issue) => `${repaired.scenarios[index]?.title ?? "Scenario"}: ${issue}`),
  );
  return {
    ...state,
    suiteDraft: {
      ...state.suiteDraft,
      scenarios: repaired.scenarios,
      assertions: repaired.scenarios.flatMap((scenario) => scenario.assertions),
      dynamicProbes: repaired.scenarios.flatMap((scenario) => scenario.dynamicProbes),
      risks: [...state.suiteDraft.risks, ...critique.risks],
    },
    verification: {
      ...verification.verification,
      runnable: verification.verification.runnable && sandboxIssues.length === 0,
      weakAssertions: [...verification.verification.weakAssertions, ...sandboxIssues],
    },
  };
}
