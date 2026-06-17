import type { OzCrawledPage } from "@kiln/shared";
import { normalizeUrl, type OzTool } from "./contracts.js";

const MAX_TEXT = 24_000;

interface CrawlUrlInput {
  url: string;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function titleFor(html: string, url: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return decodeEntities(title?.replace(/\s+/g, " ").trim() || new URL(url).hostname);
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["']/gi;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    const href = match[1];
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    try {
      links.push(normalizeUrl(new URL(href, baseUrl).toString()));
    } catch {
      // Ignore malformed links from marketing pages.
    }
  }
  return [...new Set(links)];
}

function extractText(html: string): string {
  const withCodeBlocks = html.replace(
    /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_match, code: string) => `\n\`\`\`\n${code}\n\`\`\`\n`,
  );
  return decodeEntities(
    withCodeBlocks
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, MAX_TEXT);
}

export const crawlUrlTool: OzTool<CrawlUrlInput, OzCrawledPage> = {
  name: "crawl_url",
  description: "Fetch a URL and extract readable text plus absolute links.",
  inputSchema: { type: "object", required: ["url"] },
  outputSchema: { type: "object" },
  async execute(input, ctx) {
    const url = normalizeUrl(input.url);
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const response = await fetchImpl(url, {
      headers: { "user-agent": "Kiln-Oz-Agent/1.0 (+https://tryoz.dev)" },
    });
    if (!response.ok) {
      throw new Error(`Could not crawl ${url}: HTTP ${response.status}`);
    }
    const html = await response.text();
    return {
      url,
      title: titleFor(html, url),
      text: extractText(html),
      links: extractLinks(html, url),
      fetchedAt: new Date().toISOString(),
    };
  },
};
