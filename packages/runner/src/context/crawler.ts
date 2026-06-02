/**
 * URL context crawler (Decision 15).
 *
 * Fetches a documentation URL and (optionally) one level of same-origin linked
 * pages, returning a single concatenated text blob the agent can read as
 * context. Crawl depth is controlled by the eval's {@link ContextSource}:
 *   - "single" — just the given page.
 *   - "linked" — the page plus pages it links to (one hop, same origin).
 *
 * PRODUCTION: fetch over HTTP, strip boilerplate to readable text/markdown,
 * dedupe, and cap total size. THIS IS STUBBED — there is no network in this
 * environment, so it returns deterministic placeholder content derived from the
 * URL. The depth branch is real so callers/tests can exercise both paths.
 */

/** Max characters of crawled context to keep (mirrors the production cap). */
const MAX_CHARS = 20_000;

export async function crawlUrl(
  url: string,
  depth: "single" | "linked",
): Promise<{ label: string; content: string }> {
  // STUB: real implementation would do `await fetch(url)` and extract text.
  const pages: string[] = [stubbedPage(url)];

  if (depth === "linked") {
    // PRODUCTION: parse <a href> from the root page, keep same-origin links,
    // fetch each once. STUB: synthesize two deterministic linked pages.
    pages.push(stubbedPage(url + "/guide"));
    pages.push(stubbedPage(url + "/reference"));
  }

  const content = pages.join("\n\n---\n\n").slice(0, MAX_CHARS);
  return { label: url, content };
}

/** Deterministic placeholder for one fetched page (no network). */
function stubbedPage(pageUrl: string): string {
  return [
    `# Fetched (stubbed): ${pageUrl}`,
    "",
    "[Stubbed crawl] No network in this environment. In production this is the",
    "extracted readable text of the page above, used as agent context.",
  ].join("\n");
}
