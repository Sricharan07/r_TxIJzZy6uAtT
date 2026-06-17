import type { OzCrawledPage, OzPackageCandidate, ProductPackageManager } from "@kiln/shared";
import { clampConfidence, evidence, uniqueBy, type OzTool } from "./contracts.js";

interface InspectPackageInput {
  pages: OzCrawledPage[];
}

const NPM_RE = /(?:npm\s+(?:install|i)\s+|from\s+["']|import\s+.*?\s+from\s+["'])(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)(?:["']|@|\s|$)/gi;
const PIP_RE = /pip(?:3)?\s+install\s+([a-z0-9._-]+)/gi;
const GO_RE = /go\s+get\s+([a-z0-9._/-]+)/gi;

function candidatesFor(page: OzCrawledPage, re: RegExp, manager: ProductPackageManager): OzPackageCandidate[] {
  const items: OzPackageCandidate[] = [];
  for (let match = re.exec(page.text); match; match = re.exec(page.text)) {
    const name = match[1];
    if (!name || ["react", "next", "typescript", "express"].includes(name)) continue;
    items.push({
      manager,
      name,
      evidence: [evidence(page.url, match[0] ?? name, 0.76)],
      confidence: 0.76,
    });
  }
  return items;
}

async function npmVersion(name: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    if (!response.ok) return undefined;
    const data = (await response.json()) as { "dist-tags"?: { latest?: string } };
    return data["dist-tags"]?.latest;
  } catch {
    return undefined;
  }
}

export const inspectPackageTool: OzTool<InspectPackageInput, { packages: OzPackageCandidate[] }> = {
  name: "inspect_package",
  description: "Extract SDK package names and versions from docs and package registries.",
  inputSchema: { type: "object", required: ["pages"] },
  outputSchema: { type: "object" },
  async execute(input, ctx) {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const found = input.pages.flatMap((page) => [
      ...candidatesFor(page, NPM_RE, "npm"),
      ...candidatesFor(page, PIP_RE, "pip"),
      ...candidatesFor(page, GO_RE, "go"),
    ]);
    const unique = uniqueBy(found, (pkg) => `${pkg.manager}:${pkg.name}`).slice(0, 10);
    for (const pkg of unique) {
      if (pkg.manager !== "npm") continue;
      const version = await npmVersion(pkg.name, fetchImpl);
      if (version) {
        pkg.version = version;
        pkg.confidence = clampConfidence(pkg.confidence + 0.08);
      }
    }
    return { packages: unique.sort((a, b) => b.confidence - a.confidence) };
  },
};
