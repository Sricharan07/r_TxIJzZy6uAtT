import type { OzAgentState } from "@kiln/shared";
import { safetyAgentTool } from "../tools/safety-agent-tool.js";
import type { OzToolContext } from "../tools/contracts.js";

export async function runSafetyAgent(state: OzAgentState, ctx: OzToolContext): Promise<OzAgentState> {
  if (!state.suiteDraft) throw new Error("Suite draft is required before safety review.");
  const safety = await safetyAgentTool.execute({ scenarios: state.suiteDraft.scenarios }, ctx);
  return {
    ...state,
    suiteDraft: {
      ...state.suiteDraft,
      risks: [...state.suiteDraft.risks, ...safety.risks],
    },
  };
}
