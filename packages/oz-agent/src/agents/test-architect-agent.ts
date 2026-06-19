import type { OzAgentState, OzSuiteDraft } from "@kiln/shared";
import { generateScenariosTool } from "../tools/generate-scenarios.js";
import type { OzToolContext } from "../tools/contracts.js";

export async function runTestArchitectAgent(state: OzAgentState, ctx: OzToolContext): Promise<OzAgentState> {
  if (!state.productProfile) throw new Error("Product profile is required before generating scenarios.");
  const { scenarios } = await generateScenariosTool.execute(
    { profile: state.productProfile, research: state.research, userGoal: state.input.userGoal },
    ctx,
  );
  const suiteDraft: OzSuiteDraft = {
    scenarios,
    globalSetup: [],
    globalEnv: state.productProfile.requiredEnv,
    assertions: scenarios.flatMap((scenario) => scenario.assertions),
    dynamicProbes: scenarios.flatMap((scenario) => scenario.dynamicProbes),
    confidence: scenarios.reduce((sum, scenario) => sum + scenario.confidence, 0) / Math.max(1, scenarios.length),
    risks: scenarios.flatMap((scenario) => scenario.risks),
  };
  return { ...state, suiteDraft };
}
