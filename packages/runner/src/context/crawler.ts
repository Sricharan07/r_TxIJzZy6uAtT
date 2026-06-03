/**
 * URL context crawler (Decision 15).
 *
 * Fetches a documentation URL and (optionally) one level of same-origin linked
 * pages, returning a single concatenated text blob the agent can read as
 * context. Crawl depth is controlled by the eval's {@link ContextSource}:
 *   - "single" — just the given page.
 *   - "linked" — the page plus pages it links to (one hop, same origin).
 *
 * Fetches over HTTP, strips basic HTML boilerplate to readable text, dedupes,
 * and caps total size.
 */

/** Max characters of crawled context to keep (mirrors the production cap). */
const MAX_CHARS = 20_000;

export async function crawlUrl(
  url: string,
  depth: "single" | "linked",
): Promise<{ label: string; content: string }> {
  const root = new URL(url);
  const visited = new Set<string>();
  const pages: string[] = [];
  const rootPage = await fetchPage(root.toString());
  visited.add(root.toString());
  pages.push(formatPage(root.toString(), rootPage.text));

  if (depth === "linked") {
    for (const link of rootPage.links) {
      if (pages.join("\n\n").length >= MAX_CHARS) break;
      const linked = new URL(link, root);
      if (linked.origin !== root.origin || visited.has(linked.toString())) continue;
      visited.add(linked.toString());
      const page = await fetchPage(linked.toString());
      pages.push(formatPage(linked.toString(), page.text));
      if (pages.length >= 4) break;
    }
  }

  const content = pages.join("\n\n---\n\n").slice(0, MAX_CHARS);
  return { label: url, content };
}

async function fetchPage(pageUrl: string): Promise<{ text: string; links: string[] }> {
  try {
    const res = await fetch(pageUrl);
    if (!res.ok) {
      return { text: `Fetch failed: HTTP ${res.status}`, links: [] };
    }
    const html = await res.text();
    return { text: extractText(html), links: extractLinks(html) };
  } catch (err) {
    return {
      text: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      links: [],
    };
  }
}

function formatPage(pageUrl: string, text: string): string {
  return [`# ${pageUrl}`, "", text].join("\n");
}

function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8_000);
}

function extractLinks(html: string): string[] {
  const links: string[] = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["']/gi;
  for (let match = re.exec(html); match; match = re.exec(html)) {
    links.push(match[1] as string);
  }
  return links;
}
