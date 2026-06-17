import type { OzAgentState } from "@kiln/shared";
import { crawlUrlTool } from "../tools/crawl-url.js";
import { extractCodeBlocksTool } from "../tools/extract-code-blocks.js";
import { findDocsTool } from "../tools/find-docs.js";
import { inspectGitHubTool } from "../tools/inspect-github.js";
import { inspectPackageTool } from "../tools/inspect-package.js";
import { searchWebTool } from "../tools/search-web.js";
import type { OzToolContext } from "../tools/contracts.js";

export async function runScoutAgent(state: OzAgentState, ctx: OzToolContext): Promise<OzAgentState> {
  const docs = await findDocsTool.execute({ productUrl: state.input.productUrl }, ctx);
  let homepage = state.discovery.homepage;
  try {
    homepage = await crawlUrlTool.execute({ url: docs.homepageUrl }, ctx);
  } catch {
    homepage = undefined;
  }

  const selectedDocs = [];
  for (const candidate of docs.candidates.slice(0, 5)) {
    try {
      selectedDocs.push(await crawlUrlTool.execute({ url: candidate.url }, ctx));
    } catch {
      // Keep discovery resilient; failed candidates remain visible as candidates.
    }
  }

  if (selectedDocs.length === 0) {
    const search = await searchWebTool.execute({ query: `${state.input.productUrl} developer docs api sdk` }, ctx);
    for (const result of search.results.slice(0, 3)) {
      try {
        selectedDocs.push(await crawlUrlTool.execute({ url: result.url }, ctx));
      } catch {
        // Ignore failed search hits.
      }
    }
  }

  const links = [...(homepage?.links ?? []), ...selectedDocs.flatMap((page) => page.links)];
  const [repos, packages, examples] = await Promise.all([
    inspectGitHubTool.execute({ links, productName: homepage?.title }, ctx),
    inspectPackageTool.execute({ pages: selectedDocs }, ctx),
    extractCodeBlocksTool.execute({ pages: selectedDocs }, ctx),
  ]);

  return {
    ...state,
    discovery: {
      homepage,
      docsCandidates: docs.candidates,
      selectedDocs,
      githubRepos: repos.repos,
      packages: packages.packages,
      codeExamples: examples.examples,
    },
  };
}
