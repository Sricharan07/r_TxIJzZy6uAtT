import type {
  CodeVsNoCode,
  EvalConfig,
  Finding,
  FindingStatus,
  GradeBand,
  GraderEvidence,
  Severity,
} from "@kiln/shared";
import type { SandboxHandle } from "../sandbox.js";

export interface StaticArtifact {
  path: string;
  contents: string;
}

export interface StaticGraderContext {
  runId: string;
  taskSpecId: string;
  config: EvalConfig;
  sandbox: SandboxHandle;
  artifacts: StaticArtifact[];
  observedAt: string;
}

export type StaticGrader = (context: StaticGraderContext) => Promise<Finding[]>;

const MAX_ARTIFACTS = 80;
const MAX_EXCERPT = 1_600;

const COMMON_PATHS = [
  "package.json",
  "README.md",
  "src/index.ts",
  "src/index.js",
  "src/app.ts",
  "src/app.js",
  "src/server.ts",
  "src/server.js",
  "src/checkout.ts",
  "src/checkout.js",
  "src/webhook.ts",
  "src/webhook.js",
  "app/api/webhook/route.ts",
  "app/api/webhook/route.js",
  "app/api/checkout/route.ts",
  "app/api/checkout/route.js",
  "pages/api/webhook.ts",
  "pages/api/webhook.js",
  "server.ts",
  "server.js",
  "index.ts",
  "index.js",
];

export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function contextText(config: EvalConfig): string {
  return [
    config.task,
    ...config.context.map((source) => `${source.label}\n${source.content ?? ""}`),
  ].join("\n\n");
}

export function sourceArtifacts(artifacts: StaticArtifact[]): StaticArtifact[] {
  return artifacts.filter((artifact) =>
    /\.(?:[cm]?[jt]sx?|py|go|java|rb|php|cs|rs|swift|kt|mjs|cjs)$/.test(artifact.path),
  );
}

export function redactAndClip(raw: string): { text: string; redacted: boolean } {
  const patterns = [
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]{8,}/gi,
  ];
  let text = raw;
  let redacted = false;
  for (const pattern of patterns) {
    text = text.replace(pattern, () => {
      redacted = true;
      return "[REDACTED]";
    });
  }
  if (text.length > MAX_EXCERPT) {
    text = text.slice(0, MAX_EXCERPT) + "\n[truncated]";
  }
  return { text, redacted };
}

export function makeEvidence({
  type = "static",
  replayCmd,
  excerpt,
  observedAt,
  artifactRefs,
}: {
  type?: GraderEvidence["type"];
  replayCmd: string;
  excerpt: string;
  observedAt: string;
  artifactRefs?: string[];
}): GraderEvidence {
  const redacted = redactAndClip(excerpt);
  return {
    type,
    confidence: 1,
    replayCmd,
    redactionStatus: redacted.redacted ? "redacted" : "clean",
    customerExcerpt: redacted.text,
    observedAt,
    artifactRefs,
  };
}

export function makeFinding({
  context,
  code,
  title,
  severity,
  evidence,
  status = "confirmed",
  canHardCap = severity === "critical",
  hardCapGrade,
  codeVsNoCode = "code",
}: {
  context: StaticGraderContext;
  code: string;
  title: string;
  severity: Severity;
  evidence: GraderEvidence[];
  status?: FindingStatus;
  canHardCap?: boolean;
  hardCapGrade?: GradeBand;
  codeVsNoCode?: CodeVsNoCode;
}): Finding {
  const evidenceKey = evidence.map((item) => item.customerExcerpt).join("\n");
  return {
    id: `${context.runId}:static:${code}:${stableHash(title + evidenceKey)}`,
    runId: context.runId,
    taskSpecId: context.taskSpecId,
    code,
    title,
    severity,
    status,
    canHardCap,
    hardCapGrade: canHardCap ? hardCapGrade ?? "C-" : undefined,
    evidence,
    codeVsNoCode,
  };
}

function assertionFilePaths(config: EvalConfig): string[] {
  return config.assertions.flatMap((assertion) =>
    assertion.type === "file" && "path" in assertion.config ? [assertion.config.path] : [],
  );
}

async function findCandidatePaths(sandbox: SandboxHandle): Promise<string[]> {
  const findCmd =
    "find . -maxdepth 5 -type f " +
    "\\( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' " +
    "-o -name '*.cjs' -o -name '*.py' -o -name '*.go' -o -name 'package.json' -o -name 'README.md' \\) " +
    "-not -path './node_modules/*' -not -path './.git/*' -not -path './dist/*' -not -path './.next/*'";
  const result = await sandbox.exec(findCmd);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter(Boolean);
}

export async function collectStaticArtifacts(
  config: EvalConfig,
  sandbox: SandboxHandle,
): Promise<StaticArtifact[]> {
  const paths = new Set([...COMMON_PATHS, ...assertionFilePaths(config)]);
  for (const path of await findCandidatePaths(sandbox)) {
    paths.add(path);
  }

  const artifacts: StaticArtifact[] = [];
  for (const path of [...paths].slice(0, MAX_ARTIFACTS)) {
    const contents = await sandbox.readFile(path);
    if (contents !== null) artifacts.push({ path, contents });
  }
  return artifacts;
}
