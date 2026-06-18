import type {
  ContextSource,
  OzCrawledPage,
  OzProductProfile,
  OzPackageCandidate,
  ProductEnvRequirement,
  ProductType,
} from "@kiln/shared";
import { clampConfidence, evidence, scoreText, type OzTool } from "./contracts.js";

interface ClassifyProductInput {
  productUrl: string;
  homepage?: OzCrawledPage;
  pages: OzCrawledPage[];
  packages: OzPackageCandidate[];
}

const TYPE_RULES: Array<{ type: ProductType; patterns: RegExp[] }> = [
  { type: "payments", patterns: [/payment/, /checkout/, /invoice/, /refund/, /charge/] },
  { type: "auth", patterns: [/oauth/, /login/, /session/, /identity/, /authentication/] },
  { type: "rag", patterns: [/retrieval/, /rag/, /embedding/, /index/, /knowledge/] },
  { type: "ai-sdk", patterns: [/llm/, /model/, /chat completion/, /agent/, /prompt/] },
  { type: "storage", patterns: [/bucket/, /object storage/, /upload/, /file storage/] },
  { type: "database", patterns: [/database/, /sql/, /query/, /postgres/, /vector/] },
  { type: "cli", patterns: [/cli/, /command line/, /terminal/] },
  { type: "api", patterns: [/rest api/, /http api/, /endpoint/, /openapi/, /api reference/] },
  { type: "sdk", patterns: [/sdk/, /npm install/, /pip install/, /client library/] },
  { type: "web-ui", patterns: [/dashboard/, /browser/, /web app/, /ui/] },
];

function hostName(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "").split(".")[0] ?? "Product";
}

function titleName(page: OzCrawledPage | undefined, fallback: string): string {
  const title = page?.title?.split(/[|\-–—]/)[0]?.trim();
  return title && title.length <= 48 ? title : fallback;
}

function envNameFromProduct(productName: string): string {
  const prefix = productName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .split("_")
    .slice(0, 2)
    .join("_")
    .toUpperCase();
  return `${prefix || "PRODUCT"}_API_KEY`;
}

function envNameFromLabel(productName: string, label: string): string {
  const product = productName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .split("_")
    .slice(0, 2)
    .join("_")
    .toUpperCase() || "PRODUCT";
  const suffix = label
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/^x[-_]/i, "")
    .replace(/authorization/i, "api_key")
    .replace(/bearer/i, "api_key")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `${product}_${suffix || "API_KEY"}`;
}

function envRequirements(text: string, productName: string): ProductEnvRequirement[] {
  const names = new Map<string, { description: string; required: boolean }>();
  const add = (name: string, description: string, required = true) => {
    const current = names.get(name);
    names.set(name, {
      description: current?.description ?? description,
      required: (current?.required ?? false) || required,
    });
  };
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) {
    const name = match[0];
    if (/^(HTTP|JSON|REST|SDK|API|URL|GET|POST|PUT|PATCH|DELETE|CLI|HTML|CSS)$/.test(name)) continue;
    if (/(KEY|TOKEN|SECRET|API|AUTH|PROJECT|REGION|ORG|WORKSPACE)/.test(name)) add(name, "Detected uppercase environment variable from documentation.");
  }
  for (const match of text.matchAll(/\b([a-z][a-z0-9-]*(?:key|token|secret|credential)[a-z0-9-]*|x-[a-z0-9-]*(?:key|token|secret)[a-z0-9-]*)\b/gi)) {
    const label = match[1];
    if (!label || /^(monkey|keyboard|tokenization)$/i.test(label)) continue;
    add(envNameFromLabel(productName, label), `Detected credential-like field "${label}" from documentation.`);
  }
  for (const match of text.matchAll(/\b((?:project|workspace|org|organization|tenant|account)[-_ ]?(?:id|name)|(?:project|workspace|org|organization|tenant|account)(?:Id|Name)|x-(?:project|workspace|org|organization|tenant|account)-(?:id|name))\b/gi)) {
    const label = match[1];
    if (label) add(envNameFromLabel(productName, label), `Detected required identifier field "${label}" from documentation.`);
  }
  for (const match of text.matchAll(/\b((?:index|collection|database|service|app|application)[-_ ]?(?:id|name)|(?:index|collection|database|service|app|application)(?:Id|Name)|x-(?:index|collection|database|service|app|application)-(?:id|name))\b/gi)) {
    const label = match[1];
    if (label) add(envNameFromLabel(productName, label), `Detected resource identifier field "${label}" from documentation.`, false);
  }
  for (const match of text.matchAll(/\b(authorization|bearer)\b/gi)) {
    add(envNameFromLabel(productName, match[1] ?? "api_key"), "Detected authorization header from documentation.");
  }
  for (const match of text.matchAll(/[<[{(](?:your[-_\s]*)?([a-z0-9_-]*(?:api|project|workspace|org)?[-_\s]*(?:key|token|secret))[>\]})]/gi)) {
    const label = match[1];
    if (label) add(envNameFromLabel(productName, label), `Detected credential placeholder "${label}" from documentation.`);
  }
  return [...names.entries()].slice(0, 8).map(([name, requirement]) => ({
    name,
    scopes: ["agent", "assertion", "cleanup"],
    required: requirement.required,
    description: requirement.description,
  }));
}

function authProfile(text: string, pages: OzCrawledPage[], productName: string) {
  const env = envRequirements(text, productName);
  const bearer = /bearer/i.test(text);
  const apiKey = /api[_ -]?key|project[_ -]?key|secret[_ -]?key|x-[a-z0-9-]*(?:key|token|secret)/i.test(text);
  const header = /authorization/i.test(text)
    ? "Authorization"
    : /\b(x-[a-z0-9-]*(?:key|token|secret)[a-z0-9-]*)\b/i.exec(text)?.[1] ?? undefined;
  if (!bearer && !apiKey && env.length === 0) return undefined;
  const page = pages.find((item) => /auth|api.key|authorization|bearer/i.test(item.text)) ?? pages[0];
  return {
    scheme: bearer ? "bearer" as const : apiKey ? "api_key" as const : "unknown" as const,
    headerName: header,
    envVars: env.map((item) => item.name),
    evidence: page ? [evidence(page.url, "Authentication or API key language found in docs.", 0.76)] : [],
  };
}

function endpointSurfaces(pages: OzCrawledPage[]) {
  return pages.flatMap((page) => {
    const found = new Map<string, { method?: string; target: string }>();
    for (const match of page.text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/[^\s"'`<>]+|\/[a-z0-9/_:.-]+)/gi)) {
      const method = match[1]?.toUpperCase();
      const target = match[2]?.replace(/[),.]+$/g, "");
      if (target) found.set(`${method ?? ""} ${target}`, { method, target });
    }
    for (const match of page.text.matchAll(/https?:\/\/[^\s"'`<>]+/gi)) {
      const target = match[0].replace(/[),.]+$/g, "");
      if (/\/v\d+|api|graphql|manage|query|search|index/i.test(target)) found.set(target, { target });
    }
    return [...found.values()].slice(0, 8).map((item) => ({
      name: item.method ? `${item.method} ${item.target}` : item.target,
      method: item.method ? endpointMethod(item.method) : undefined,
      path: item.target,
      description: "Documented API endpoint found in product docs.",
      evidence: [evidence(page.url, item.method ? `${item.method} ${item.target}` : item.target, 0.82)],
    }));
  });
}

function endpointMethod(method: string) {
  return method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
}

const SDK_PACKAGE_PATTERNS: Array<{ manager: OzPackageCandidate["manager"]; regex: RegExp }> = [
  { manager: "npm", regex: /(?:npm\s+(?:install|i)|pnpm\s+add|yarn\s+add)\s+(?:--[a-z0-9-]+\s+)*(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)/gi },
  { manager: "npm", regex: /(?:import\s+(?:[\s\S]{0,120}?\s+from\s+)?|from\s+)["'](@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)["']/gi },
  { manager: "pip", regex: /pip(?:3)?\s+install\s+([a-z0-9._-]+)/gi },
  { manager: "go", regex: /go\s+get\s+([a-z0-9._/-]+)/gi },
];

function languageForManager(manager: OzPackageCandidate["manager"]) {
  return manager === "npm" ? "node" as const : manager === "pip" ? "python" as const : manager === "go" ? "go" as const : "curl" as const;
}

function installCommandFor(pkg: OzPackageCandidate): string | undefined {
  if (pkg.manager === "npm") return `npm install ${pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name}`;
  if (pkg.manager === "pip") return `pip install ${pkg.version ? `${pkg.name}==${pkg.version}` : pkg.name}`;
  if (pkg.manager === "go") return `go get ${pkg.name}`;
  return undefined;
}

function importHintFor(pkg: OzPackageCandidate): string | undefined {
  if (pkg.manager === "npm") return `node --input-type=module -e "await import('${pkg.name}')"`;
  if (pkg.manager === "pip") return `python - <<'PY'\nimport ${pkg.name.replace(/[-.]/g, "_")}\nPY`;
  return undefined;
}

function likelySdkSymbol(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*(Client|SDK|Api|API|Index|Session|Service|Provider|Store|Database)$/.test(name);
}

function sdkSymbolsNear(text: string, packageName: string): string[] {
  const symbols = new Set<string>();
  const packageIndex = text.indexOf(packageName);
  const windowText = packageIndex >= 0
    ? text.slice(Math.max(0, packageIndex - 4_000), Math.min(text.length, packageIndex + 8_000))
    : text;
  for (const match of windowText.matchAll(/\b([A-Z][A-Za-z0-9]*(?:Client|SDK|Api|API|Index|Session|Service|Provider|Store|Database))\b/g)) {
    const symbol = match[1];
    if (symbol && likelySdkSymbol(symbol)) symbols.add(symbol);
  }
  return [...symbols].slice(0, 12);
}

function sdkMethodsNear(text: string, packageName: string): string[] {
  const methods = new Set<string>();
  const packageIndex = text.indexOf(packageName);
  const windowText = packageIndex >= 0
    ? text.slice(Math.max(0, packageIndex - 4_000), Math.min(text.length, packageIndex + 8_000))
    : text;
  for (const match of windowText.matchAll(/\.([a-z][A-Za-z0-9_]{2,40})\s*\(/g)) {
    const method = match[1];
    if (method && !["then", "catch", "map", "filter", "reduce", "log", "error"].includes(method)) methods.add(method);
  }
  return [...methods].slice(0, 16);
}

function packageCandidatesFromDocs(pages: OzCrawledPage[]): OzPackageCandidate[] {
  const byKey = new Map<string, OzPackageCandidate>();
  for (const page of pages) {
    for (const pattern of SDK_PACKAGE_PATTERNS) {
      for (const match of page.text.matchAll(pattern.regex)) {
        const name = match[1];
        if (!name || ["react", "next", "typescript", "express"].includes(name)) continue;
        const key = `${pattern.manager}:${name}`;
        const existing = byKey.get(key);
        const candidate: OzPackageCandidate = {
          manager: pattern.manager,
          name,
          evidence: [evidence(page.url, match[0] ?? name, 0.8)],
          confidence: 0.8,
        };
        byKey.set(key, existing
          ? {
              ...existing,
              confidence: Math.max(existing.confidence, candidate.confidence),
              evidence: [...existing.evidence, ...candidate.evidence].slice(0, 3),
            }
          : candidate);
      }
    }
  }
  return [...byKey.values()];
}

function surfaces(pages: OzCrawledPage[]) {
  const heuristicSurfaces = [
    [/quickstart|first call/i, "First successful call"],
    [/webhook/i, "Webhook handling"],
    [/idempot/i, "Idempotency"],
    [/auth|api key|bearer/i, "Authentication"],
    [/error|invalid/i, "Error handling"],
  ].flatMap(([pattern, name]) => {
    const page = pages.find((item) => (pattern as RegExp).test(item.text));
    return page
      ? [{
          name: name as string,
          description: `${name} appears in the discovered documentation.`,
          evidence: [evidence(page.url, name as string, 0.72)],
        }]
      : [];
  });
  const apiSurfaces = [...endpointSurfaces(pages), ...heuristicSurfaces];
  const webhookPage = pages.find((item) => /webhook/i.test(item.text));
  return {
    APIs: apiSurfaces,
    webhooks: webhookPage
      ? [{
          name: "Webhook signature verification",
          signatureHeader: /signature/i.test(webhookPage.text) ? "signature header documented" : undefined,
          description: "Webhook docs were found; agents should verify signatures before trusting events.",
          evidence: [evidence(webhookPage.url, "Webhook documentation found.", 0.75)],
        }]
      : [],
  };
}

function docsSources(pages: OzCrawledPage[]): ContextSource[] {
  return pages.map((page) => ({ type: "url", label: page.url, crawlDepth: "single" }));
}

export function productProfileToEvalProfile(profile: OzProductProfile, pages: OzCrawledPage[]) {
  return {
    companyName: profile.companyName,
    productName: profile.productName,
    productType: profile.productType[0] ?? "other",
    runtime: { language: "node" as const, image: "default" as const, nodeVersion: ">=20" },
    docsSources: docsSources(pages),
    packages: profile.sdks.map((sdk) => ({
      manager: sdk.manager,
      name: sdk.packageName,
      installCommand: sdk.installCommand,
      importCheck: sdk.importHint,
    })),
    requiredEnv: profile.requiredEnv,
    setupSteps: [],
    preflightChecks: [],
    cleanupSteps: [],
  };
}

export const classifyProductTool: OzTool<ClassifyProductInput, { profile: OzProductProfile }> = {
  name: "classify_product",
  description: "Classify product category, auth, SDKs, API surfaces, env vars, and evidence.",
  inputSchema: { type: "object", required: ["productUrl", "pages", "packages"] },
  outputSchema: { type: "object" },
  async execute(input) {
    const text = [input.homepage?.text ?? "", ...input.pages.map((page) => page.text)].join("\n");
    const productTypes = TYPE_RULES
      .map((rule) => ({ type: rule.type, score: scoreText(text, rule.patterns) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((item) => item.type);
    const fallbackName = hostName(input.productUrl);
    const productName = titleName(input.homepage ?? input.pages[0], fallbackName);
    const auth = authProfile(text, input.pages, productName);
    const detectedEnv = envRequirements(text, productName);
    const requiredEnv = auth && detectedEnv.length === 0
      ? [{
          name: envNameFromProduct(productName),
          scopes: ["agent", "assertion", "cleanup"],
          required: true,
          description: "Oz inferred this API key env var from authentication docs; review before running.",
        } satisfies ProductEnvRequirement]
      : detectedEnv;
    if (auth && auth.envVars.length === 0 && requiredEnv.length > 0) {
      auth.envVars = requiredEnv.map((env) => env.name);
    }
    const surfacesResult = surfaces(input.pages);
    const packageCandidates = new Map<string, OzPackageCandidate>();
    for (const pkg of [...input.packages, ...packageCandidatesFromDocs(input.pages)]) {
      const key = `${pkg.manager}:${pkg.name}`;
      const existing = packageCandidates.get(key);
      packageCandidates.set(key, existing
        ? {
            ...existing,
            version: existing.version ?? pkg.version,
            confidence: Math.max(existing.confidence, pkg.confidence),
            evidence: [...existing.evidence, ...pkg.evidence].slice(0, 4),
          }
        : pkg);
    }
    const sdks = [...packageCandidates.values()].map((pkg) => ({
      language: languageForManager(pkg.manager),
      packageName: pkg.name,
      manager: pkg.manager,
      installCommand: installCommandFor(pkg),
      importHint: importHintFor(pkg),
      symbols: sdkSymbolsNear(text, pkg.name),
      methods: sdkMethodsNear(text, pkg.name),
      evidence: pkg.evidence,
    }));
    const evidenceSource = input.pages[0]?.url ?? input.productUrl;
    const confidence = clampConfidence(0.45 + Math.min(0.25, input.pages.length * 0.04) + Math.min(0.18, sdks.length * 0.09));
    return {
      profile: {
        companyName: productName,
        productName,
        productType: productTypes.length ? productTypes : ["other"],
        summary: `${productName} appears to expose ${productTypes.join(", ") || "developer"} integration surfaces based on discovered docs.`,
        auth,
        sdks,
        APIs: surfacesResult.APIs,
        webhooks: surfacesResult.webhooks,
        requiredEnv,
        confidence,
        evidence: [evidence(evidenceSource, "Product classification is based on crawled homepage and documentation text.", confidence)],
      },
    };
  },
};
