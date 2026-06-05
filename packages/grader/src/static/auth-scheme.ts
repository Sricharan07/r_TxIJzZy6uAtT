import type { Finding } from "@kiln/shared";
import {
  contextText,
  makeEvidence,
  makeFinding,
  sourceArtifacts,
  type StaticArtifact,
  type StaticGraderContext,
} from "./shared.js";

type AuthScheme = "bearer" | "x-api-key" | "basic";

function expectedScheme(text: string): AuthScheme | null {
  const lower = text.toLowerCase();
  if (/authorization\s*:\s*bearer\b/i.test(text) || lower.includes("bearer token")) {
    return "bearer";
  }
  if (lower.includes("x-api-key") || lower.includes("x api key")) return "x-api-key";
  if (lower.includes("basic auth") || /authorization\s*:\s*basic\b/i.test(text)) return "basic";
  return null;
}

function hasExpectedScheme(contents: string, expected: AuthScheme): boolean {
  switch (expected) {
    case "bearer":
      return /\bbearer\s+/i.test(contents);
    case "x-api-key":
      return /\bx-api-key\b/i.test(contents);
    case "basic":
      return /\bbasic\s+/i.test(contents);
  }
}

function hasWrongScheme(contents: string, expected: AuthScheme): boolean {
  const wrongPatterns: Record<AuthScheme, RegExp[]> = {
    bearer: [/\bbasic\s+/i, /\bx-api-key\b/i, /\bapi[_-]?key\b/i],
    "x-api-key": [/\bbearer\s+/i, /\bbasic\s+/i],
    basic: [/\bbearer\s+/i, /\bx-api-key\b/i, /\bapi[_-]?key\b/i],
  };
  return wrongPatterns[expected].some((pattern) => pattern.test(contents));
}

function firstAuthLine(artifact: StaticArtifact): string {
  return (
    artifact.contents
      .split("\n")
      .find((line) => /authorization|bearer|basic|x-api-key|api[_-]?key/i.test(line)) ??
    artifact.contents.slice(0, 180)
  );
}

export async function runAuthSchemeGrader(
  context: StaticGraderContext,
): Promise<Finding[]> {
  const expected = expectedScheme(contextText(context.config));
  if (!expected) return [];

  const source = sourceArtifacts(context.artifacts);
  const wrong = source.find(
    (artifact) =>
      hasWrongScheme(artifact.contents, expected) &&
      !hasExpectedScheme(artifact.contents, expected),
  );
  if (!wrong) return [];

  return [
    makeFinding({
      context,
      code: "wrong_auth_scheme",
      title: `Generated code does not use ${expected} authentication`,
      severity: "high",
      canHardCap: false,
      evidence: [
        makeEvidence({
          replayCmd:
            "grep -RInE 'Authorization|Bearer|Basic|x-api-key|api[_-]?key' . --exclude-dir=node_modules --exclude-dir=.git",
          excerpt: `${wrong.path}: ${firstAuthLine(wrong)}`,
          artifactRefs: [wrong.path],
          observedAt: context.observedAt,
        }),
      ],
    }),
  ];
}
