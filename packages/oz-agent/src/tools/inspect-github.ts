import type { OzGitHubRepoCandidate } from "@kiln/shared";
import { clampConfidence, evidence, normalizeUrl, uniqueBy, type OzTool } from "./contracts.js";

interface InspectGitHubInput {
  links: string[];
  productName?: string;
}

export const inspectGitHubTool: OzTool<InspectGitHubInput, { repos: OzGitHubRepoCandidate[] }> = {
  name: "inspect_github",
  description: "Identify GitHub repositories linked by product docs or examples.",
  inputSchema: { type: "object", required: ["links"] },
  outputSchema: { type: "object" },
  async execute(input) {
    const repos = input.links
      .filter((link) => /github\.com\/[^/]+\/[^/#?]+/i.test(link))
      .map((link): OzGitHubRepoCandidate => {
        const url = normalizeUrl(link).replace(/\/(tree|blob)\/.*$/, "");
        const productHit = input.productName ? url.toLowerCase().includes(input.productName.toLowerCase()) : false;
        return {
          url,
          reason: "Repository linked from discovered product documentation.",
          confidence: clampConfidence(productHit ? 0.82 : 0.62),
        };
      });
    return { repos: uniqueBy(repos, (repo) => repo.url).slice(0, 8) };
  },
};

export function githubEvidence(repo: OzGitHubRepoCandidate) {
  return evidence(repo.url, repo.reason, repo.confidence);
}
