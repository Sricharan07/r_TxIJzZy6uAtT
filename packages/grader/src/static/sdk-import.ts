import type { Finding } from "@kiln/shared";
import {
  contextText,
  makeEvidence,
  makeFinding,
  sourceArtifacts,
  type StaticArtifact,
  type StaticGraderContext,
} from "./shared.js";

const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "timers",
  "tty",
  "url",
  "util",
  "worker_threads",
  "zlib",
]);

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function normalizePackage(specifier: string): string | null {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.endsWith(".css")
  ) {
    return null;
  }
  const cleaned = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const firstSegment = cleaned.split("/")[0] ?? cleaned;
  if (NODE_BUILTINS.has(cleaned) || NODE_BUILTINS.has(firstSegment)) return null;
  const parts = cleaned.split("/");
  return cleaned.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? null;
}

function extractImports(artifact: StaticArtifact): string[] {
  const imports = new Set<string>();
  const patterns = [
    /import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of artifact.contents.matchAll(pattern)) {
      const normalized = normalizePackage(match[1] ?? "");
      if (normalized) imports.add(normalized);
    }
  }
  return [...imports];
}

function readPackageJson(artifacts: StaticArtifact[]): PackageJson | null {
  const artifact = artifacts.find((item) => item.path === "package.json");
  if (!artifact) return null;
  try {
    return JSON.parse(artifact.contents) as PackageJson;
  } catch {
    return null;
  }
}

function declaredPackages(pkg: PackageJson | null): Set<string> {
  const declared = new Set<string>();
  if (!pkg) return declared;
  if (pkg.name) declared.add(pkg.name);
  for (const deps of [
    pkg.dependencies,
    pkg.devDependencies,
    pkg.peerDependencies,
    pkg.optionalDependencies,
  ]) {
    for (const name of Object.keys(deps ?? {})) declared.add(name);
  }
  return declared;
}

function expectedPackages(context: string): string[] {
  const expected = new Set<string>();
  const patterns = [
    /\b(?:npm\s+install|npm\s+i|pnpm\s+add|yarn\s+add|bun\s+add)\s+(@?[a-z0-9._-]+(?:\/[a-z0-9._-]+)?)/gi,
    /\b(?:sdk\s+package|package)\s*[:=]\s*(@?[a-z0-9._-]+(?:\/[a-z0-9._-]+)?)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of context.matchAll(pattern)) {
      const normalized = normalizePackage(match[1] ?? "");
      if (normalized) expected.add(normalized);
    }
  }
  return [...expected];
}

function expectedPackagesForConfig(context: StaticGraderContext): string[] {
  if (context.config.productProfile) {
    return [...new Set((context.config.productProfile.packages ?? []).map((pkg) => pkg.name))];
  }
  return expectedPackages(contextText(context.config));
}

export async function runSdkImportGrader(
  context: StaticGraderContext,
): Promise<Finding[]> {
  const pkg = readPackageJson(context.artifacts);
  const declared = declaredPackages(pkg);
  const importsByFile = sourceArtifacts(context.artifacts).flatMap((artifact) =>
    extractImports(artifact).map((name) => ({ artifact, name })),
  );
  const imported = new Set(importsByFile.map((item) => item.name));
  const findings: Finding[] = [];

  for (const item of importsByFile) {
    if (pkg && !declared.has(item.name)) {
      findings.push(
        makeFinding({
          context,
          code: "hallucinated_package",
          title: `Imported package is not declared: ${item.name}`,
          severity: "critical",
          evidence: [
            makeEvidence({
              replayCmd: `node -e "const p=require('./package.json'); process.exit((p.dependencies&&p.dependencies['${item.name}'])||(p.devDependencies&&p.devDependencies['${item.name}'])?0:1)"`,
              excerpt: `${item.artifact.path} imports "${item.name}", but package.json does not declare it.`,
              artifactRefs: [item.artifact.path, "package.json"],
              observedAt: context.observedAt,
            }),
          ],
        }),
      );
    }
  }

  for (const expected of expectedPackagesForConfig(context)) {
    if (!declared.has(expected) && !imported.has(expected)) {
      findings.push(
        makeFinding({
          context,
          code: "sdk_not_discovered",
          title: `Expected SDK/package was not used: ${expected}`,
          severity: "high",
          canHardCap: false,
          evidence: [
            makeEvidence({
              replayCmd: `grep -RIn ${expected} . --exclude-dir=node_modules --exclude-dir=.git`,
              excerpt: `Context references "${expected}", but generated artifacts do not import or declare it.`,
              observedAt: context.observedAt,
            }),
          ],
        }),
      );
    }
  }

  return findings;
}
