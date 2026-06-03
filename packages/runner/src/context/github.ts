/**
 * GitHub repo context ingestion (Decision 15).
 *
 * Clones a repository (shallow) and reads the requested paths/globs into a
 * single concatenated text blob the agent gets as context. `paths` lets evals
 * scope ingestion to the relevant directories (e.g. ["/src", "/examples"]) so
 * the agent isn't drowned in an entire monorepo.
 *
 * Performs `git clone --depth=1`, walks the requested paths, filters to text
 * files, concatenates with per-file headers, and caps total size.
 */
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/** Max characters of repo context to keep (mirrors the production cap). */
const MAX_CHARS = 40_000;
const MAX_FILES = 40;

export async function cloneRepo(
  repoUrl: string,
  paths: string[],
): Promise<{ label: string; content: string }> {
  const scoped = paths.length > 0 ? paths : ["/"];
  const tempDir = await mkdtemp(join(tmpdir(), "kiln-repo-"));
  const repoDir = join(tempDir, "repo");
  try {
    try {
      await execFile("git", ["clone", "--depth=1", normalizeRepoUrl(repoUrl), repoDir], {
        timeout: 60_000,
      });
    } catch (err) {
      return {
        label: `${repoUrl} — ${scoped.join(", ")}`,
        content: `GitHub repo clone failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const sections: string[] = [];
    for (const path of scoped) {
      const fullPath = safeRepoPath(repoDir, path);
      const files = await collectFiles(fullPath);
      for (const file of files) {
        if (sections.length >= MAX_FILES || sections.join("\n\n").length >= MAX_CHARS) break;
        const content = await readTextFile(file);
        if (content === null) continue;
        const rel = file.slice(repoDir.length + 1);
        sections.push(`## ${rel}\n${content.slice(0, 4_000)}`);
      }
    }
    return { label: `${repoUrl} — ${scoped.join(", ")}`, content: sections.join("\n\n").slice(0, MAX_CHARS) };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function normalizeRepoUrl(repoUrl: string): string {
  const trimmed = repoUrl.split(/\s+—\s+|\s+/)[0] ?? repoUrl;
  if (trimmed.startsWith("http") || trimmed.startsWith("git@")) return trimmed;
  return `https://${trimmed.replace(/^github\.com\//, "github.com/")}`;
}

function safeRepoPath(repoDir: string, path: string): string {
  const fullPath = resolve(repoDir, path.replace(/^\//, ""));
  if (fullPath !== repoDir && !fullPath.startsWith(repoDir + "/")) {
    throw new Error(`Repo path escapes checkout: ${path}`);
  }
  return fullPath;
}

async function collectFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === ".git" || entry === "node_modules" || entry.startsWith(".")) continue;
    const fullPath = join(path, entry);
    const entryInfo = await stat(fullPath);
    if (entryInfo.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
    } else if (entryInfo.isFile() && isLikelyText(fullPath)) {
      files.push(fullPath);
    }
    if (files.length >= MAX_FILES) break;
  }
  return files;
}

function isLikelyText(path: string): boolean {
  const name = basename(path).toLowerCase();
  return /\.(md|mdx|txt|ts|tsx|js|jsx|json|py|go|rs|rb|java|kt|cs|php|yml|yaml|toml|html|css)$/.test(name);
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    const content = await readFile(path, "utf8");
    return content.includes("\u0000") ? null : content;
  } catch {
    return null;
  }
}
