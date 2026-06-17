import type { OzAgentState } from "@kiln/shared";
import { generateAssertionsTool } from "../tools/generate-assertions.js";
import type { OzToolContext } from "../tools/contracts.js";

export async function runAssertionEngineerAgent(state: OzAgentState, ctx: OzToolContext): Promise<OzAgentState> {
  if (!state.productProfile || !state.suiteDraft) {
    throw new Error("Product profile and suite draft are required before generating assertions.");
  }
  const result = await generateAssertionsTool.execute(
    { profile: state.productProfile, scenarios: state.suiteDraft.scenarios },
    ctx,
  );
  return {
    ...state,
    suiteDraft: {
      ...state.suiteDraft,
      scenarios: result.scenarios,
      assertions: result.assertions,
      dynamicProbes: result.dynamicProbes,
    },
  };
}
