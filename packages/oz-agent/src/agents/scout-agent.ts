import type { OzAgentState, OzDocsCandidate } from "@kiln/shared";
import { crawlUrlTool } from "../tools/crawl-url.js";
import { extractCodeBlocksTool } from "../tools/extract-code-blocks.js";
import { findDocsTool } from "../tools/find-docs.js";
import { inspectGitHubTool } from "../tools/inspect-github.js";
import { inspectPackageTool } from "../tools/inspect-package.js";
import { searchWebTool } from "../tools/search-web.js";
import type { OzToolContext } from "../tools/contracts.js";

const DOC_SELECTION_LIMIT = 8;

const COVERAGE_RULES: Array<{ key: string; pattern: RegExp }> = [
  { key: "quickstart", pattern: /quickstart|getting-started|introduction|start/i },
  { key: "auth", pattern: /auth|authentication|api[-_ ]?key|token|credential/i },
  { key: "sdk", pattern: /sdk|javascript|typescript|node|client|reference\/js|api-reference\/js|npm/i },
  { key: "api", pattern: /api|reference|endpoint|rest|graphql|\/v\d+/i },
  { key: "workflow", pattern: /retrieval|query|search|index|document|webhook|example|guide|tutorial/i },
];

function selectDocsCandidates(candidates: OzDocsCandidate[], submittedUrl: string): OzDocsCandidate[] {
  const selected = new Map<string, OzDocsCandidate>();
  const add = (candidate: OzDocsCandidate | undefined): void => {
    if (!candidate || selected.has(candidate.url) || selected.size >= DOC_SELECTION_LIMIT) return;
    selected.set(candidate.url, candidate);
  };
  add(candidates.find((candidate) => candidate.url === submittedUrl));
  for (const rule of COVERAGE_RULES) {
    add(candidates.find((candidate) => rule.pattern.test(`${candidate.url} ${candidate.label} ${candidate.reason}`)));
  }
  for (const candidate of candidates) add(candidate);
  return [...selected.values()];
}

export async function runScoutAgent(state: OzAgentState, ctx: OzToolContext): Promise<OzAgentState> {
  const docs = await findDocsTool.execute({ productUrl: state.input.productUrl }, ctx);
  let homepage = state.discovery.homepage;
  try {
    homepage = await crawlUrlTool.execute({ url: docs.homepageUrl }, ctx);
  } catch {
    homepage = undefined;
  }

  const selectedDocs = [];
  for (const candidate of selectDocsCandidates(docs.candidates, docs.homepageUrl)) {
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
