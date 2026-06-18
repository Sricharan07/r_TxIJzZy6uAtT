import type { OzDocsCandidate } from "@kiln/shared";
import { clampConfidence, normalizeUrl, scoreText, type OzTool } from "./contracts.js";
import { crawlUrlTool } from "./crawl-url.js";

interface FindDocsInput {
  productUrl: string;
}

const DOC_PATHS = [
  "/docs",
  "/documentation",
  "/developers",
  "/developer",
  "/api",
  "/reference",
  "/quickstart",
  "/guides",
  "/learn",
];

const DOC_PATTERNS = [/docs?/, /developer/, /api/, /reference/, /quickstart/, /guide/, /sdk/, /auth/, /webhook/];

function candidateFromUrl(url: string, source: "link" | "path" | "sitemap" | "llms", reason: string): OzDocsCandidate {
  const score = scoreText(url, DOC_PATTERNS);
  const sourceBonus = source === "llms" ? 0.16 : source === "sitemap" ? 0.1 : source === "path" ? 0.05 : 0;
  return {
    url,
    label: new URL(url).pathname || "/",
    reason,
    confidence: clampConfidence(0.35 + score * 0.08 + sourceBonus),
  };
}

function strongestCandidatePerUrl(candidates: OzDocsCandidate[]): OzDocsCandidate[] {
  const byUrl = new Map<string, OzDocsCandidate>();
  for (const candidate of candidates) {
    const existing = byUrl.get(candidate.url);
    if (!existing || candidate.confidence > existing.confidence) {
      byUrl.set(candidate.url, candidate);
    }
  }
  return [...byUrl.values()];
}

async function sitemapUrls(root: URL, fetchImpl: typeof fetch): Promise<string[]> {
  try {
    const response = await fetchImpl(new URL("/sitemap.xml", root).toString());
    if (!response.ok) return [];
    const xml = await response.text();
    return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)]
      .map((match) => match[1] ?? "")
      .filter(Boolean)
      .map((url) => normalizeUrl(url));
  } catch {
    return [];
  }
}

async function llmsTxtUrls(root: URL, fetchImpl: typeof fetch): Promise<string[]> {
  try {
    const response = await fetchImpl(new URL("/llms.txt", root).toString(), {
      headers: { "user-agent": "Kiln-Oz-Agent/1.0 (+https://tryoz.dev)" },
    });
    if (!response.ok) return [];
    const text = await response.text();
    const urls = new Set<string>();
    for (const match of text.matchAll(/\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/g)) {
      const raw = match[1];
      if (raw) urls.add(normalizeUrl(new URL(raw, root).toString()));
    }
    for (const match of text.matchAll(/https?:\/\/[^\s)>"']+/g)) {
      urls.add(normalizeUrl(match[0].replace(/[),.]+$/g, "")));
    }
    return [...urls];
  } catch {
    return [];
  }
}

export const findDocsTool: OzTool<FindDocsInput, { homepageUrl: string; candidates: OzDocsCandidate[] }> = {
  name: "find_docs",
  description: "Find likely documentation pages from a product homepage, common docs paths, and sitemap.",
  inputSchema: { type: "object", required: ["productUrl"] },
  outputSchema: { type: "object" },
  async execute(input, ctx) {
    const homepageUrl = normalizeUrl(input.productUrl);
    const root = new URL(homepageUrl);
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const homepage = await crawlUrlTool.execute({ url: homepageUrl }, ctx);
    const linked = homepage.links
      .filter((link) => new URL(link).origin === root.origin)
      .filter((link) => scoreText(link, DOC_PATTERNS) > 0)
      .map((link) => candidateFromUrl(link, "link", "Linked from the product homepage."));
    const commonPaths = DOC_PATHS.map((path) =>
      candidateFromUrl(new URL(path, root).toString(), "path", `Common developer documentation path: ${path}`),
    );
    const sitemap = (await sitemapUrls(root, fetchImpl))
      .filter((url) => new URL(url).origin === root.origin)
      .filter((url) => scoreText(url, DOC_PATTERNS) > 0)
      .slice(0, 20)
      .map((url) => candidateFromUrl(url, "sitemap", "Found in sitemap.xml."));
    const llms = (await llmsTxtUrls(root, fetchImpl))
      .filter((url) => new URL(url).origin === root.origin)
      .filter((url) => scoreText(url, DOC_PATTERNS) > 0)
      .slice(0, 40)
      .map((url) => candidateFromUrl(url, "llms", "Found in llms.txt."));
    const submitted = candidateFromUrl(homepageUrl, "link", "Submitted URL.");
    const candidates = strongestCandidatePerUrl([submitted, ...linked, ...llms, ...sitemap, ...commonPaths])
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 30);
    return { homepageUrl, candidates };
  },
};
