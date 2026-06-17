import type { OzAgentState } from "@kiln/shared";
import { classifyProductTool } from "../tools/classify-product.js";
import type { OzToolContext } from "../tools/contracts.js";

export async function runProductAnalystAgent(state: OzAgentState, ctx: OzToolContext): Promise<OzAgentState> {
  const result = await classifyProductTool.execute(
    {
      productUrl: state.input.productUrl,
      homepage: state.discovery.homepage,
      pages: state.discovery.selectedDocs,
      packages: state.discovery.packages,
    },
    ctx,
  );
  return { ...state, productProfile: result.profile };
}
