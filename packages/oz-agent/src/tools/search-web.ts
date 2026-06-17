import { normalizeUrl, type OzTool } from "./contracts.js";

interface SearchWebInput {
  query: string;
}

export interface SearchWebResult {
  title: string;
  url: string;
  snippet: string;
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const searchWebTool: OzTool<SearchWebInput, { results: SearchWebResult[] }> = {
  name: "search_web",
  description: "Search the public web for product documentation when direct discovery is insufficient.",
  inputSchema: { type: "object", required: ["query"] },
  outputSchema: { type: "object" },
  async execute(input, ctx) {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
    try {
      const response = await fetchImpl(url, { headers: { "user-agent": "Kiln-Oz-Agent/1.0" } });
      if (!response.ok) return { results: [] };
      const html = await response.text();
      const results: SearchWebResult[] = [];
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      for (let match = re.exec(html); match && results.length < 8; match = re.exec(html)) {
        const rawUrl = match[1] ?? "";
        const parsed = new URL(rawUrl, "https://duckduckgo.com");
        const uddg = parsed.searchParams.get("uddg");
        results.push({
          title: decode(match[2] ?? ""),
          url: normalizeUrl(uddg ?? rawUrl),
          snippet: decode(match[3] ?? ""),
        });
      }
      return { results };
    } catch {
      return { results: [] };
    }
  },
};
