import type {
  OzAgentState,
  OzClaimConflict,
  OzEvidence,
  OzPackageCandidate,
  OzResearchClaim,
  OzResearchReport,
  OzResearchSourceType,
} from "@kiln/shared";
import { clampConfidence, evidence, uniqueBy } from "../tools/contracts.js";
import type { OzToolContext } from "../tools/contracts.js";

type ClaimInput = Omit<OzResearchClaim, "id" | "confidence"> & { confidence?: number };

interface NpmPackageJson {
  name?: string;
  version?: string;
  license?: string;
  engines?: { node?: string };
  types?: string;
  typings?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  repository?: NpmRepository;
  directories?: { lib?: string };
  readme?: string;
  "dist-tags"?: { latest?: string };
  versions?: Record<string, {
    version?: string;
    license?: string;
    engines?: { node?: string };
    types?: string;
    typings?: string;
    main?: string;
    module?: string;
    exports?: unknown;
    repository?: NpmRepository;
    directories?: { lib?: string };
  }>;
}

interface NpmManifest {
  name?: string;
  version?: string;
  license?: string;
  engines?: { node?: string };
  types?: string;
  typings?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  repository?: NpmRepository;
  directories?: { lib?: string };
}

type NpmRepository = string | { type?: string; url?: string; directory?: string };

interface PypiJson {
  info?: {
    name?: string;
    version?: string;
    license?: string;
    requires_python?: string;
    requires_dist?: string[];
    summary?: string;
    description?: string;
    home_page?: string;
    project_urls?: Record<string, string>;
  };
}

const FETCH_TIMEOUT_MS = 8_000;

type FetchResource<T> =
  | { status: "ok"; data: T }
  | { status: "missing"; statusCode: number }
  | { status: "unavailable"; statusCode?: number };

function claimKey(input: Pick<OzResearchClaim, "kind" | "subject" | "value" | "sourceType"> & { source: string }): string {
  return `${input.kind}:${input.subject}:${input.value}:${input.sourceType}:${input.source}`;
}

function claim(input: ClaimInput): OzResearchClaim {
  const confidence = clampConfidence(input.confidence ?? input.evidence.confidence);
  return {
    ...input,
    id: claimKey({
      kind: input.kind,
      subject: input.subject,
      value: input.value,
      sourceType: input.sourceType,
      source: input.evidence.source,
    }),
    confidence,
  };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function snippet(text: string, index: number, length = 180): string {
  return normalizeWhitespace(text.slice(Math.max(0, index - 80), Math.min(text.length, index + length)));
}

function sourceEvidence(source: string, quote: string, confidence: number): OzEvidence {
  return evidence(source, quote, confidence);
}

function addTextClaims({
  claims,
  text,
  source,
  sourceType,
}: {
  claims: OzResearchClaim[];
  text: string;
  source: string;
  sourceType: OzResearchSourceType;
}): void {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return;

  for (const match of normalized.matchAll(/\bNode(?:\.js)?\s*(?:version\s*)?(?:>=\s*|v)?(1[89]|2\d)(?:\.\d+)?\+?/gi)) {
    const major = match[1];
    if (!major) continue;
    claims.push(claim({
      kind: "runtime.node",
      subject: "node",
      value: `>=${major}`,
      sourceType,
      evidence: sourceEvidence(source, snippet(normalized, match.index ?? 0), 0.82),
    }));
  }

  for (const match of normalized.matchAll(/\bPython\s*(?:>=\s*)?([23]\.\d+)\+?/gi)) {
    const version = match[1];
    if (!version) continue;
    claims.push(claim({
      kind: "runtime.python",
      subject: "python",
      value: `>=${version}`,
      sourceType,
      evidence: sourceEvidence(source, snippet(normalized, match.index ?? 0), 0.78),
    }));
  }

  for (const match of normalized.matchAll(/\b(npm\s+(?:install|i)\s+(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+))/gi)) {
    const name = match[2];
    if (!name || ["react", "next", "typescript", "express"].includes(name)) continue;
    claims.push(claim({
      kind: "package.npm",
      subject: name,
      value: name,
      sourceType,
      evidence: sourceEvidence(source, match[1] ?? name, 0.82),
    }));
  }

  for (const match of normalized.matchAll(/\b(pip(?:3)?\s+install\s+([a-z0-9._-]+))/gi)) {
    const name = match[2];
    if (!name) continue;
    claims.push(claim({
      kind: "package.pip",
      subject: name,
      value: name,
      sourceType,
      evidence: sourceEvidence(source, match[1] ?? name, 0.78),
    }));
  }

  for (const match of normalized.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) {
    const name = match[1];
    if (!name || /^(HTTP|JSON|REST|SDK|API|URL|GET|POST|PUT|PATCH|DELETE|CLI|HTML|CSS)$/.test(name)) continue;
    if (!/(KEY|TOKEN|SECRET|AUTH|PROJECT|ORG|WORKSPACE|TENANT|ACCOUNT)/.test(name)) continue;
    claims.push(claim({
      kind: "auth.env",
      subject: name,
      value: name,
      sourceType,
      evidence: sourceEvidence(source, snippet(normalized, match.index ?? 0, 80), 0.72),
    }));
  }

  for (const match of normalized.matchAll(/\b(Authorization|x-[a-z0-9-]*(?:key|token|secret|version|id|name))\b/gi)) {
    const header = match[1];
    if (!header) continue;
    claims.push(claim({
      kind: "auth.header",
      subject: header.toLowerCase(),
      value: header.toLowerCase(),
      sourceType,
      evidence: sourceEvidence(source, snippet(normalized, match.index ?? 0, 90), 0.74),
    }));
  }

  for (const match of normalized.matchAll(/\b(projectId|project_id|project ID|workspaceId|workspace_id|organizationId|orgId)\b/gi)) {
    const field = match[1];
    if (!field) continue;
    claims.push(claim({
      kind: "auth.body_field",
      subject: field.replace(/\s+/g, "").toLowerCase(),
      value: field.replace(/\s+/g, ""),
      sourceType,
      evidence: sourceEvidence(source, snippet(normalized, match.index ?? 0, 90), 0.72),
    }));
  }

  if (/Authorization\s*:\s*Bearer|\bBearer token\b/i.test(normalized)) {
    claims.push(claim({
      kind: "auth.scheme",
      subject: "bearer",
      value: "bearer",
      sourceType,
      evidence: sourceEvidence(source, "Bearer authentication is referenced.", 0.76),
    }));
  }

  for (const match of normalized.matchAll(/\b(BSD-2-Clause|BSD-3-Clause|MIT|Apache-2\.0|ISC|PolyForm Shield|GPL-3\.0|AGPL-3\.0|MPL-2\.0)\b/gi)) {
    const license = match[1];
    if (!license) continue;
    claims.push(claim({
      kind: "license",
      subject: "product",
      value: normalizeLicense(license),
      sourceType,
      evidence: sourceEvidence(source, snippet(normalized, match.index ?? 0, 120), 0.8),
    }));
  }

  if (/loadIndex\(\).*before.*query|before.*query.*loadIndex\(\)|call\s+loadIndex\(\)\s+before\s+query/i.test(normalized)) {
    claims.push(claim({
      kind: "query.load_required",
      subject: "query",
      value: "load_required",
      sourceType,
      evidence: sourceEvidence(source, "Docs state or imply loadIndex() is required before query().", 0.75),
    }));
  }
  if (/without\s+loadIndex\(\).*cloud|falls?\s+back\s+to\s+(?:the\s+)?cloud|query\(\).*cloud\s+endpoint/i.test(normalized)) {
    claims.push(claim({
      kind: "query.cloud_fallback",
      subject: "query",
      value: "cloud_fallback",
      sourceType,
      evidence: sourceEvidence(source, "Docs or package README state query can fall back to cloud behavior.", 0.76),
    }));
  }
}

function addDocumentedSdkClaims(state: OzAgentState, claims: OzResearchClaim[]): void {
  for (const sdk of state.productProfile?.sdks ?? []) {
    const source = sdk.evidence[0]?.source ?? "product_profile";
    for (const symbol of sdk.symbols ?? []) {
      claims.push(claim({
        kind: "sdk.doc_symbol",
        subject: sdk.packageName,
        value: symbol,
        sourceType: "docs",
        evidence: sourceEvidence(source, `Docs reference SDK symbol ${symbol} from ${sdk.packageName}.`, 0.78),
      }));
    }
    for (const method of sdk.methods ?? []) {
      claims.push(claim({
        kind: "sdk.doc_method",
        subject: sdk.packageName,
        value: method,
        sourceType: "docs",
        evidence: sourceEvidence(source, `Docs reference SDK method ${method}() from ${sdk.packageName}.`, 0.76),
      }));
    }
  }
}

function pythonImportsFromText(text: string): Array<{ module: string; symbol?: string }> {
  const imports: Array<{ module: string; symbol?: string }> = [];
  for (const match of text.matchAll(/\bfrom\s+([a-zA-Z_][\w.]*)\s+import\s+([A-Za-z_][\w]*)/g)) {
    const module = match[1]?.split(".")[0];
    const symbol = match[2];
    if (module) imports.push({ module, ...(symbol ? { symbol } : {}) });
  }
  for (const match of text.matchAll(/\bimport\s+([a-zA-Z_][\w.]*)/g)) {
    const module = match[1]?.split(".")[0];
    if (module) imports.push({ module });
  }
  return imports.filter((item) => !["os", "sys", "json", "time", "typing", "asyncio", "requests", "pathlib"].includes(item.module));
}

function addPythonSdkTextClaims({
  claims,
  text,
  source,
  sourceType,
  pkgName,
  documented,
}: {
  claims: OzResearchClaim[];
  text: string;
  source: string;
  sourceType: OzResearchSourceType;
  pkgName: string;
  documented: boolean;
}): void {
  for (const item of pythonImportsFromText(text)) {
    claims.push(claim({
      kind: documented ? "sdk.doc_py_module" : "sdk.py_module",
      subject: pkgName,
      value: item.module,
      sourceType,
      evidence: sourceEvidence(source, `${documented ? "Docs" : "Package metadata"} reference Python import module ${item.module}.`, documented ? 0.74 : 0.68),
    }));
    if (item.symbol) {
      claims.push(claim({
        kind: documented ? "sdk.doc_py_symbol" : "sdk.py_symbol",
        subject: pkgName,
        value: item.symbol,
        sourceType,
        evidence: sourceEvidence(source, `${documented ? "Docs" : "Package metadata"} reference Python import symbol ${item.symbol}.`, documented ? 0.72 : 0.66),
      }));
    }
  }
}

function addDocumentedPythonClaims(state: OzAgentState, claims: OzResearchClaim[]): void {
  const docsText = state.discovery.selectedDocs.map((page) => page.text).join("\n");
  for (const sdk of state.productProfile?.sdks ?? []) {
    if (sdk.manager !== "pip" && sdk.language !== "python") continue;
    const source = sdk.evidence[0]?.source ?? state.discovery.selectedDocs[0]?.url ?? "product_profile";
    addPythonSdkTextClaims({
      claims,
      text: docsText,
      source,
      sourceType: "docs",
      pkgName: sdk.packageName,
      documented: true,
    });
  }
}

function normalizeLicense(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "-");
}

function nodeMajor(value: string): number | null {
  const match = /(\d+)/.exec(value);
  return match?.[1] ? Number(match[1]) : null;
}

function pythonMinor(value: string): string | null {
  const match = /([23])\.(\d+)/.exec(value);
  return match?.[1] && match[2] ? `${match[1]}.${match[2]}` : null;
}

function conflict(
  id: string,
  input: Omit<OzClaimConflict, "id" | "confidence"> & { confidence?: number },
): OzClaimConflict {
  return {
    ...input,
    id,
    confidence: clampConfidence(input.confidence ?? Math.max(...input.claims.map((item) => item.confidence), 0.7)),
  };
}

function claimsByKind(claims: OzResearchClaim[], kind: string): OzResearchClaim[] {
  return claims.filter((item) => item.kind === kind);
}

function valuesDiffer(claims: OzResearchClaim[]): boolean {
  return new Set(claims.map((item) => item.value.toLowerCase())).size > 1;
}

function packageId(value: string): string {
  return value.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "package";
}

function strongestPerValue(claims: OzResearchClaim[]): OzResearchClaim[] {
  const byValue = new Map<string, OzResearchClaim>();
  for (const item of claims) {
    const key = item.value.toLowerCase();
    const existing = byValue.get(key);
    if (!existing || item.confidence > existing.confidence) byValue.set(key, item);
  }
  return [...byValue.values()];
}

function analyzeConflicts(claims: OzResearchClaim[]): OzClaimConflict[] {
  const conflicts: OzClaimConflict[] = [];
  const nodeClaims = strongestPerValue(claimsByKind(claims, "runtime.node"));
  const nodeMajors = new Set(nodeClaims.map((item) => nodeMajor(item.value)).filter((value) => value !== null));
  if (nodeMajors.size > 1) {
    conflicts.push(conflict("runtime-node-version-mismatch", {
      category: "environment",
      title: "Node runtime requirement is inconsistent across sources",
      severity: "medium",
      status: "confirmed",
      claims: nodeClaims,
      recommendation: "Publish one runtime matrix for docs, README, and package metadata, and make quickstarts use the same Node major version.",
    }));
  }

  const pythonClaims = strongestPerValue(claimsByKind(claims, "runtime.python"));
  const pythonMinors = new Set(pythonClaims.map((item) => pythonMinor(item.value)).filter((value) => value !== null));
  if (pythonMinors.size > 1) {
    conflicts.push(conflict("runtime-python-version-mismatch", {
      category: "environment",
      title: "Python runtime requirement is inconsistent across sources",
      severity: "medium",
      status: "confirmed",
      claims: pythonClaims,
      recommendation: "Publish one Python runtime matrix for docs, package metadata, and examples, and make quickstarts use the same minimum Python version.",
    }));
  }

  const licenseClaims = strongestPerValue(claims.filter((item) => item.kind === "license" || item.kind === "package.license"));
  if (licenseClaims.length > 1 && valuesDiffer(licenseClaims)) {
    conflicts.push(conflict("license-claim-mismatch", {
      category: "docs",
      title: "License claims differ across official sources",
      severity: "medium",
      status: "confirmed",
      claims: licenseClaims,
      recommendation: "Align repository, docs, and package registry license statements before users rely on production/commercial usage guidance.",
    }));
  }

  const envClaims = claimsByKind(claims, "auth.env");
  const headerClaims = claimsByKind(claims, "auth.header").filter((item) => item.value !== "authorization");
  const bodyClaims = claimsByKind(claims, "auth.body_field");
  if (envClaims.length > 0 && (headerClaims.length > 0 || bodyClaims.length > 0)) {
    conflicts.push(conflict("auth-shape-ambiguity", {
      category: "auth",
      title: "Auth credentials are described with multiple shapes",
      severity: "medium",
      status: "suspected",
      claims: strongestPerValue([...envClaims, ...headerClaims, ...bodyClaims]).slice(0, 8),
      recommendation: "Add a mapping table that connects dashboard labels, SDK environment variables, REST headers, and REST body fields.",
      confidence: 0.74,
    }));
  }

  const loadClaims = claimsByKind(claims, "query.load_required");
  const fallbackClaims = claimsByKind(claims, "query.cloud_fallback");
  if (loadClaims.length > 0 && fallbackClaims.length > 0) {
    conflicts.push(conflict("query-load-semantics-ambiguous", {
      category: "sdk",
      title: "Query/loadIndex behavior is ambiguous",
      severity: "medium",
      status: "confirmed",
      claims: strongestPerValue([...loadClaims, ...fallbackClaims]),
      recommendation: "Document whether query() requires a local load, can fall back to a cloud endpoint, and how agents should test each path.",
    }));
  }

  const packages = claims.filter((item) => item.kind === "package.registry_missing");
  for (const item of packages) {
    conflicts.push(conflict(`package-missing-${packageId(item.subject)}`, {
      category: "sdk",
      title: `Documented package was not found in ${item.sourceType} registry`,
      severity: "high",
      status: "confirmed",
      claims: [item],
      recommendation: "Fix the install command or publish the documented SDK package before using it in quickstarts.",
    }));
  }

  const packagesWithTypeClaims = new Set(claims.filter((item) => item.kind === "sdk.symbol" || item.kind === "sdk.method").map((item) => item.subject));
  const documentedPackages = new Set(claims.filter((item) => item.kind === "sdk.doc_symbol" || item.kind === "sdk.doc_method").map((item) => item.subject));
  for (const pkg of documentedPackages) {
    if (!packagesWithTypeClaims.has(pkg)) continue;
    const typeSymbols = new Set(claims.filter((item) => item.kind === "sdk.symbol" && item.subject === pkg).map((item) => item.value.toLowerCase()));
    const documentedSymbols = strongestPerValue(claims.filter((item) => item.kind === "sdk.doc_symbol" && item.subject === pkg));
    const missingSymbols = documentedSymbols.filter((item) => !typeSymbols.has(item.value.toLowerCase()));
    if (missingSymbols.length > 0) {
      conflicts.push(conflict(`sdk-symbols-missing-${packageId(pkg)}`, {
        category: "sdk",
        title: "Documented SDK symbols are missing from published type declarations",
        severity: "high",
        status: "confirmed",
        claims: [
          ...missingSymbols.slice(0, 6),
          ...claims.filter((item) => item.kind === "sdk.symbol" && item.subject === pkg).slice(0, 6),
        ],
        recommendation: "Align docs examples with the published SDK exports, or publish type declarations for the documented symbols before using them in quickstarts.",
        confidence: 0.86,
      }));
    }

    const typeMethods = new Set(claims.filter((item) => item.kind === "sdk.method" && item.subject === pkg).map((item) => item.value.toLowerCase()));
    const documentedMethods = strongestPerValue(claims.filter((item) => item.kind === "sdk.doc_method" && item.subject === pkg));
    const missingMethods = documentedMethods.filter((item) => !typeMethods.has(item.value.toLowerCase()));
    if (missingMethods.length > 0) {
      conflicts.push(conflict(`sdk-methods-missing-${packageId(pkg)}`, {
        category: "sdk",
        title: "Documented SDK methods are missing from published type declarations",
        severity: "medium",
        status: "suspected",
        claims: [
          ...missingMethods.slice(0, 8),
          ...claims.filter((item) => item.kind === "sdk.method" && item.subject === pkg).slice(0, 8),
        ],
        recommendation: "Check whether the docs use stale method names, undocumented prototype extensions, or examples from an unreleased SDK version.",
        confidence: 0.78,
      }));
    }
  }

  for (const item of claims.filter((claimItem) => claimItem.kind === "sdk.types_unavailable")) {
    conflicts.push(conflict(`sdk-types-unavailable-${packageId(item.subject)}`, {
      category: "sdk",
      title: "Published SDK type declaration path does not resolve",
      severity: "medium",
      status: "confirmed",
      claims: [item],
      recommendation: "Fix the package metadata types/typings path or publish the missing declaration file so agents can inspect the SDK surface reliably.",
    }));
  }

  for (const item of claims.filter((claimItem) => claimItem.kind === "package.entrypoint_missing")) {
    conflicts.push(conflict(`package-entrypoint-missing-${packageId(item.subject)}`, {
      category: "sdk",
      title: "Published package entrypoint metadata does not resolve",
      severity: "high",
      status: "confirmed",
      claims: [item],
      recommendation: "Fix the package main/module entrypoint metadata or publish the referenced build artifact before docs direct agents to import the package.",
    }));
  }

  const pythonPackages = new Set(claims.filter((item) => item.kind === "sdk.doc_py_module").map((item) => item.subject));
  for (const pkg of pythonPackages) {
    const documented = strongestPerValue(claims.filter((item) => item.kind === "sdk.doc_py_module" && item.subject === pkg));
    const metadata = strongestPerValue(claims.filter((item) => item.kind === "sdk.py_module" && item.subject === pkg));
    if (documented.length === 0 || metadata.length === 0) continue;
    const metadataModules = new Set(metadata.map((item) => item.value.toLowerCase()));
    const missing = documented.filter((item) => !metadataModules.has(item.value.toLowerCase()));
    if (missing.length > 0) {
      conflicts.push(conflict(`python-import-module-mismatch-${packageId(pkg)}`, {
        category: "sdk",
        title: "Documented Python import module differs from package metadata examples",
        severity: "medium",
        status: "suspected",
        claims: [...missing.slice(0, 6), ...metadata.slice(0, 6)],
        recommendation: "Clarify the pip package name versus Python import module name, and keep Python examples aligned with the package README/metadata.",
        confidence: 0.72,
      }));
    }
  }

  return conflicts;
}

async function fetchResponse(fetchImpl: typeof fetch, url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextResource(fetchImpl: typeof fetch, url: string): Promise<FetchResource<string>> {
  const response = await fetchResponse(fetchImpl, url);
  if (!response) return { status: "unavailable" };
  if (response.status === 404 || response.status === 410) return { status: "missing", statusCode: response.status };
  if (!response.ok) return { status: "unavailable", statusCode: response.status };
  try {
    return { status: "ok", data: await response.text() };
  } catch {
    return { status: "unavailable", statusCode: response.status };
  }
}

async function fetchJsonResource<T>(fetchImpl: typeof fetch, url: string): Promise<FetchResource<T>> {
  const response = await fetchResponse(fetchImpl, url);
  if (!response) return { status: "unavailable" };
  if (response.status === 404 || response.status === 410) return { status: "missing", statusCode: response.status };
  if (!response.ok) return { status: "unavailable", statusCode: response.status };
  try {
    return { status: "ok", data: await response.json() as T };
  } catch {
    return { status: "unavailable", statusCode: response.status };
  }
}

async function fetchText(fetchImpl: typeof fetch, url: string): Promise<string | null> {
  const resource = await fetchTextResource(fetchImpl, url);
  return resource.status === "ok" ? resource.data : null;
}

function githubRepoPath(url: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/#?]+)/i.exec(url);
  return match?.[1]?.replace(/\.git$/, "") ?? null;
}

function repositoryInfo(repository: NpmRepository | undefined): { repoPath: string; directory?: string } | null {
  if (!repository) return null;
  const rawUrl = typeof repository === "string" ? repository : repository.url;
  if (!rawUrl) return null;
  const normalized = rawUrl
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@github\.com[:/]/, "https://github.com/")
    .replace(/^git@github\.com:/, "https://github.com/");
  const repoPath = normalized.startsWith("github:")
    ? normalized.replace(/^github:/, "").replace(/\.git$/, "")
    : githubRepoPath(normalized);
  if (!repoPath) return null;
  const directory = typeof repository === "string" ? undefined : repository.directory?.replace(/^\/+|\/+$/g, "");
  return { repoPath, ...(directory ? { directory } : {}) };
}

function githubRawUrl(repoPath: string, ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${repoPath}/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function versionRefs(version: string | undefined): string[] {
  return version ? [`v${version}`, version, `release-${version}`] : [];
}

function packagePaths(directory: string | undefined, file: string): string[] {
  const paths = directory ? [`${directory}/${file}`, file] : [file];
  return uniqueBy(paths, (item) => item);
}

async function addGithubClaims(claims: OzResearchClaim[], checkedSources: Set<string>, state: OzAgentState, fetchImpl: typeof fetch): Promise<void> {
  for (const repo of state.discovery.githubRepos.slice(0, 4)) {
    const repoPath = githubRepoPath(repo.url);
    if (!repoPath) continue;
    for (const branch of ["main", "master"]) {
      const readmeUrl = `https://raw.githubusercontent.com/${repoPath}/${branch}/README.md`;
      const readme = await fetchText(fetchImpl, readmeUrl);
      if (readme) {
        checkedSources.add(readmeUrl);
        addTextClaims({ claims, text: readme, source: repo.url, sourceType: "github" });
        break;
      }
    }
    for (const branch of ["main", "master"]) {
      const pkgUrl = `https://raw.githubusercontent.com/${repoPath}/${branch}/package.json`;
      const raw = await fetchText(fetchImpl, pkgUrl);
      if (!raw) continue;
      checkedSources.add(pkgUrl);
      try {
        const pkg = JSON.parse(raw) as { name?: string; license?: string; engines?: { node?: string } };
        if (pkg.license) {
          claims.push(claim({
            kind: "license",
            subject: "product",
            value: normalizeLicense(pkg.license),
            sourceType: "github",
            evidence: sourceEvidence(repo.url, `package.json license: ${pkg.license}`, 0.86),
          }));
        }
        if (pkg.engines?.node) {
          claims.push(claim({
            kind: "runtime.node",
            subject: "node",
            value: pkg.engines.node,
            sourceType: "github",
            evidence: sourceEvidence(repo.url, `package.json engines.node: ${pkg.engines.node}`, 0.9),
          }));
        }
      } catch {
        // Ignore malformed repository package metadata.
      }
      break;
    }
  }
}

function candidatePackages(state: OzAgentState): OzPackageCandidate[] {
  const fromProfile = state.productProfile?.sdks.map((sdk): OzPackageCandidate => ({
    manager: sdk.manager,
    name: sdk.packageName,
    evidence: sdk.evidence,
    confidence: 0.82,
  })) ?? [];
  return uniqueBy([...state.discovery.packages, ...fromProfile], (pkg) => `${pkg.manager}:${pkg.name}`).slice(0, 12);
}

function unpkgUrl(pkgName: string, version: string | undefined, path: string): string {
  const normalizedPath = path.replace(/^\.\//, "").split("/").map(encodeURIComponent).join("/");
  return `https://unpkg.com/${pkgName}${version ? `@${encodeURIComponent(version)}` : ""}/${normalizedPath}`;
}

function exportEntrypoints(exportsField: unknown): string[] {
  if (!exportsField) return [];
  if (typeof exportsField === "string") return [exportsField];
  if (typeof exportsField !== "object" || Array.isArray(exportsField)) return [];
  const paths: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      paths.push(value);
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const item of Object.values(value)) visit(item);
  };
  visit(exportsField);
  return paths;
}

function entrypointPaths(manifest: Pick<NpmManifest, "main" | "module" | "exports">): string[] {
  return uniqueBy([manifest.main, manifest.module, ...exportEntrypoints(manifest.exports)].filter((item): item is string => Boolean(item)), (item) => item)
    .filter((item) => !/^https?:\/\//i.test(item))
    .slice(0, 4);
}

async function addRepositoryPackageClaims({
  claims,
  checkedSources,
  pkg,
  manifest,
  version,
  fetchImpl,
}: {
  claims: OzResearchClaim[];
  checkedSources: Set<string>;
  pkg: OzPackageCandidate;
  manifest: NpmManifest;
  version?: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const info = repositoryInfo(manifest.repository);
  if (!info) return;
  const refs = [...versionRefs(version), "main", "master"];
  for (const ref of refs) {
    let foundForRef = false;
    for (const readmePath of packagePaths(info.directory, "README.md")) {
      const readmeUrl = githubRawUrl(info.repoPath, ref, readmePath);
      checkedSources.add(readmeUrl);
      const readme = await fetchText(fetchImpl, readmeUrl);
      if (!readme) continue;
      foundForRef = true;
      addTextClaims({ claims, text: readme, source: `https://github.com/${info.repoPath}/tree/${ref}`, sourceType: "github" });
      break;
    }
    for (const pkgPath of packagePaths(info.directory, "package.json")) {
      const pkgUrl = githubRawUrl(info.repoPath, ref, pkgPath);
      checkedSources.add(pkgUrl);
      const raw = await fetchText(fetchImpl, pkgUrl);
      if (!raw) continue;
      foundForRef = true;
      try {
        const repoPkg = JSON.parse(raw) as NpmManifest;
        if (repoPkg.name && repoPkg.name !== pkg.name) continue;
        if (repoPkg.license) {
          claims.push(claim({
            kind: "license",
            subject: "product",
            value: normalizeLicense(repoPkg.license),
            sourceType: "github",
            evidence: sourceEvidence(pkgUrl, `Repository package.json license: ${repoPkg.license}`, 0.86),
          }));
        }
        if (repoPkg.engines?.node) {
          claims.push(claim({
            kind: "runtime.node",
            subject: "node",
            value: repoPkg.engines.node,
            sourceType: "github",
            evidence: sourceEvidence(pkgUrl, `Repository package.json engines.node: ${repoPkg.engines.node}`, 0.88),
          }));
        }
      } catch {
        // Ignore malformed repository package metadata.
      }
      break;
    }
    if (foundForRef && versionRefs(version).includes(ref)) return;
  }
}

function addTypeSurfaceClaims(claims: OzResearchClaim[], pkgName: string, source: string, typeText: string): void {
  const symbolClaims = new Set<string>();
  for (const match of typeText.matchAll(/\b(?:export\s+)?(?:declare\s+)?(?:class|interface|type|enum|function|const)\s+([A-Z][A-Za-z0-9_]*)\b/g)) {
    const symbol = match[1];
    if (symbol) symbolClaims.add(symbol);
  }
  for (const match of typeText.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const symbol = raw.trim().split(/\s+as\s+/i)[1] ?? raw.trim().split(/\s+as\s+/i)[0];
      if (symbol && /^[A-Z][A-Za-z0-9_]*$/.test(symbol)) symbolClaims.add(symbol);
    }
  }
  for (const symbol of [...symbolClaims].slice(0, 80)) {
    claims.push(claim({
      kind: "sdk.symbol",
      subject: pkgName,
      value: symbol,
      sourceType: "sdk_types",
      evidence: sourceEvidence(source, `Published type declarations export ${symbol}.`, 0.84),
    }));
  }

  const methods = new Set<string>();
  for (const match of typeText.matchAll(/(?:^|[\s;{])(?:abstract\s+|public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+)*([a-z][A-Za-z0-9_]{2,48})\s*\(/gm)) {
    const method = match[1];
    if (!method || ["constructor", "then", "catch", "finally"].includes(method)) continue;
    methods.add(method);
  }
  for (const method of [...methods].slice(0, 120)) {
    claims.push(claim({
      kind: "sdk.method",
      subject: pkgName,
      value: method,
      sourceType: "sdk_types",
      evidence: sourceEvidence(source, `Published type declarations include ${method}().`, 0.82),
    }));
  }
}

async function addNpmLivePackageClaims({
  claims,
  checkedSources,
  pkg,
  version,
  registryTypesPath,
  registryManifest,
  fetchImpl,
}: {
  claims: OzResearchClaim[];
  checkedSources: Set<string>;
  pkg: OzPackageCandidate;
  version?: string;
  registryTypesPath?: string;
  registryManifest?: Pick<NpmManifest, "main" | "module" | "exports" | "repository" | "directories">;
  fetchImpl: typeof fetch;
}): Promise<void> {
  if (!version) return;
  const manifestUrl = unpkgUrl(pkg.name, version, "package.json");
  const manifestResource = await fetchJsonResource<NpmManifest>(fetchImpl, manifestUrl);
  checkedSources.add(manifestUrl);
  const manifest = manifestResource.status === "ok" ? manifestResource.data : undefined;
  const effectiveManifest = manifest ?? registryManifest;
  const typesPath = manifest?.types ?? manifest?.typings ?? registryTypesPath;
  if (manifest?.license) {
    claims.push(claim({
      kind: "package.license",
      subject: pkg.name,
      value: normalizeLicense(manifest.license),
      sourceType: "package_probe",
      evidence: sourceEvidence(manifestUrl, `Published package manifest license: ${manifest.license}`, 0.88),
    }));
  }
  if (manifest?.engines?.node) {
    claims.push(claim({
      kind: "runtime.node",
      subject: "node",
      value: manifest.engines.node,
      sourceType: "package_probe",
      evidence: sourceEvidence(manifestUrl, `Published package manifest engines.node: ${manifest.engines.node}`, 0.88),
    }));
  }
  if (typesPath) {
    claims.push(claim({
      kind: "package.types",
      subject: pkg.name,
      value: typesPath,
      sourceType: "package_probe",
      evidence: sourceEvidence(manifestUrl, `Published package declares type declarations at ${typesPath}`, 0.84),
    }));
    const typeUrl = unpkgUrl(pkg.name, version, typesPath);
    const typeResource = await fetchTextResource(fetchImpl, typeUrl);
    checkedSources.add(typeUrl);
    if (typeResource.status === "ok") {
      addTypeSurfaceClaims(claims, pkg.name, typeUrl, typeResource.data);
    } else if (typeResource.status === "missing") {
      claims.push(claim({
        kind: "sdk.types_unavailable",
        subject: pkg.name,
        value: typesPath,
        sourceType: "package_probe",
        evidence: sourceEvidence(typeUrl, `Declared type declaration path did not resolve: ${typesPath}`, 0.88),
      }));
    }
  }

  for (const path of entrypointPaths(effectiveManifest ?? {}).slice(0, 3)) {
    const entryUrl = unpkgUrl(pkg.name, version, path);
    const entryResource = await fetchTextResource(fetchImpl, entryUrl);
    checkedSources.add(entryUrl);
    if (entryResource.status === "unavailable") continue;
    claims.push(claim({
      kind: entryResource.status === "ok" ? "package.entrypoint_resolves" : "package.entrypoint_missing",
      subject: pkg.name,
      value: path,
      sourceType: "package_probe",
      evidence: sourceEvidence(entryUrl, entryResource.status === "ok" ? `Published entrypoint resolves: ${path}` : `Published entrypoint did not resolve: ${path}`, entryResource.status === "ok" ? 0.76 : 0.86),
    }));
  }
  if (effectiveManifest) {
    await addRepositoryPackageClaims({
      claims,
      checkedSources,
      pkg,
      manifest: effectiveManifest,
      version,
      fetchImpl,
    });
  }
}

async function addNpmClaims(claims: OzResearchClaim[], checkedSources: Set<string>, pkg: OzPackageCandidate, fetchImpl: typeof fetch): Promise<void> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`;
  const resource = await fetchJsonResource<NpmPackageJson>(fetchImpl, url);
  checkedSources.add(url);
  if (resource.status === "missing") {
    claims.push(claim({
      kind: "package.registry_missing",
      subject: pkg.name,
      value: pkg.name,
      sourceType: "npm",
      evidence: sourceEvidence(url, `npm package was not found: ${pkg.name}`, 0.9),
    }));
    return;
  }
  if (resource.status !== "ok") return;
  const data = resource.data;
  const latest = data["dist-tags"]?.latest;
  const latestPackage = latest ? data.versions?.[latest] : undefined;
  const license = latestPackage?.license ?? data.license;
  const enginesNode = latestPackage?.engines?.node ?? data.engines?.node;
  const types = latestPackage?.types ?? latestPackage?.typings ?? data.types ?? data.typings;
  const registryManifest = latestPackage ?? data;
  if (latest) {
    claims.push(claim({
      kind: "package.version",
      subject: pkg.name,
      value: latest,
      sourceType: "npm",
      evidence: sourceEvidence(url, `npm latest version: ${latest}`, 0.86),
    }));
  }
  if (license) {
    claims.push(claim({
      kind: "package.license",
      subject: pkg.name,
      value: normalizeLicense(license),
      sourceType: "npm",
      evidence: sourceEvidence(url, `npm license: ${license}`, 0.9),
    }));
  }
  if (enginesNode) {
    claims.push(claim({
      kind: "runtime.node",
      subject: "node",
      value: enginesNode,
      sourceType: "npm",
      evidence: sourceEvidence(url, `npm engines.node: ${enginesNode}`, 0.9),
    }));
  }
  if (types) {
    claims.push(claim({
      kind: "package.types",
      subject: pkg.name,
      value: types,
      sourceType: "npm",
      evidence: sourceEvidence(url, `npm type definitions: ${types}`, 0.8),
    }));
  }
  if (data.readme) {
    addTextClaims({ claims, text: data.readme, source: `npm:${pkg.name}`, sourceType: "npm" });
  }
  await addNpmLivePackageClaims({
    claims,
    checkedSources,
    pkg,
    version: latest,
    registryTypesPath: types,
    registryManifest,
    fetchImpl,
  });
}

async function addPypiClaims(claims: OzResearchClaim[], checkedSources: Set<string>, pkg: OzPackageCandidate, fetchImpl: typeof fetch): Promise<void> {
  const url = `https://pypi.org/pypi/${encodeURIComponent(pkg.name)}/json`;
  const resource = await fetchJsonResource<PypiJson>(fetchImpl, url);
  checkedSources.add(url);
  if (resource.status === "missing" || (resource.status === "ok" && !resource.data.info)) {
    claims.push(claim({
      kind: "package.registry_missing",
      subject: pkg.name,
      value: pkg.name,
      sourceType: "pypi",
      evidence: sourceEvidence(url, `PyPI package was not found: ${pkg.name}`, 0.9),
    }));
    return;
  }
  if (resource.status !== "ok") return;
  const info = resource.data.info;
  if (!info) return;
  if (info.version) {
    claims.push(claim({
      kind: "package.version",
      subject: pkg.name,
      value: info.version,
      sourceType: "pypi",
      evidence: sourceEvidence(url, `PyPI latest version: ${info.version}`, 0.86),
    }));
  }
  if (info.license) {
    claims.push(claim({
      kind: "package.license",
      subject: pkg.name,
      value: normalizeLicense(info.license),
      sourceType: "pypi",
      evidence: sourceEvidence(url, `PyPI license: ${info.license}`, 0.82),
    }));
  }
  if (info.requires_python) {
    claims.push(claim({
      kind: "runtime.python",
      subject: "python",
      value: info.requires_python,
      sourceType: "pypi",
      evidence: sourceEvidence(url, `PyPI requires_python: ${info.requires_python}`, 0.88),
    }));
  }
  if (info.description) {
    addTextClaims({ claims, text: info.description, source: `pypi:${pkg.name}`, sourceType: "pypi" });
    addPythonSdkTextClaims({
      claims,
      text: info.description,
      source: `pypi:${pkg.name}`,
      sourceType: "pypi",
      pkgName: pkg.name,
      documented: false,
    });
  }
}

async function addPackageRegistryClaims(claims: OzResearchClaim[], checkedSources: Set<string>, state: OzAgentState, fetchImpl: typeof fetch): Promise<void> {
  for (const pkg of candidatePackages(state)) {
    if (pkg.manager === "npm") await addNpmClaims(claims, checkedSources, pkg, fetchImpl);
    if (pkg.manager === "pip") await addPypiClaims(claims, checkedSources, pkg, fetchImpl);
  }
}

export async function runDocsResearchAgent(state: OzAgentState, ctx: OzToolContext): Promise<OzAgentState> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const claims: OzResearchClaim[] = [];
  const checkedSources = new Set<string>();

  for (const page of state.discovery.selectedDocs) {
    checkedSources.add(page.url);
    addTextClaims({ claims, text: page.text, source: page.url, sourceType: "docs" });
  }
  addDocumentedSdkClaims(state, claims);
  addDocumentedPythonClaims(state, claims);

  await addGithubClaims(claims, checkedSources, state, fetchImpl);
  await addPackageRegistryClaims(claims, checkedSources, state, fetchImpl);

  const uniqueClaims = uniqueBy(claims, (item) => item.id);
  const report: OzResearchReport = {
    claims: uniqueClaims,
    conflicts: analyzeConflicts(uniqueClaims),
    checkedSources: [...checkedSources],
    generatedAt: new Date().toISOString(),
  };
  return { ...state, research: report };
}
