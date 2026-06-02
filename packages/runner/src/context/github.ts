/**
 * GitHub repo context ingestion (Decision 15).
 *
 * Clones a repository (shallow) and reads the requested paths/globs into a
 * single concatenated text blob the agent gets as context. `paths` lets evals
 * scope ingestion to the relevant directories (e.g. ["/src", "/examples"]) so
 * the agent isn't drowned in an entire monorepo.
 *
 * PRODUCTION: `git clone --depth=1`, walk the requested paths, filter to text
 * files, concatenate with per-file headers, and cap total size. THIS IS STUBBED
 * — no git/network here — so it returns deterministic placeholder content
 * derived from the repo URL and paths. The path-scoping shape is real.
 */

/** Max characters of repo context to keep (mirrors the production cap). */
const MAX_CHARS = 40_000;

export async function cloneRepo(
  repoUrl: string,
  paths: string[],
): Promise<{ label: string; content: string }> {
  // STUB: real implementation would shell out to `git clone --depth=1` into a
  // temp dir, then read files under each requested path.
  const scoped = paths.length > 0 ? paths : ["/"];
  const sections = scoped.map((p) => stubbedTree(repoUrl, p));

  const label = `${repoUrl} — ${scoped.join(", ")}`;
  const content = sections.join("\n\n").slice(0, MAX_CHARS);
  return { label, content };
}

/** Deterministic placeholder for one ingested path (no git/network). */
function stubbedTree(repoUrl: string, path: string): string {
  return [
    `## ${repoUrl}${path}`,
    "[Stubbed clone] No git/network in this environment. In production this is",
    `the concatenated text of files under \`${path}\`, used as agent context.`,
  ].join("\n");
}
