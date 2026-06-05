import type { Finding } from "@kiln/shared";
import {
  makeEvidence,
  makeFinding,
  sourceArtifacts,
  type StaticGraderContext,
} from "./shared.js";

const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
];

const LOG_SECRET_PATTERN =
  /\b(?:console\.(?:log|warn|error)|logger\.(?:info|warn|error|debug)|print|println)\s*\([^)]*(?:api[_-]?key|token|secret|password)[^)]*\)/i;

function lineWithMatch(contents: string, pattern: RegExp): string | null {
  return contents.split("\n").find((line) => pattern.test(line)) ?? null;
}

export async function runSecretLeakGrader(
  context: StaticGraderContext,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const artifact of sourceArtifacts(context.artifacts)) {
    const loggedSecret = lineWithMatch(artifact.contents, LOG_SECRET_PATTERN);
    if (loggedSecret) {
      findings.push(
        makeFinding({
          context,
          code: "secret_in_logs",
          title: "Secret-like value is written to logs",
          severity: "critical",
          hardCapGrade: "F",
          evidence: [
            makeEvidence({
              replayCmd:
                "grep -RInE 'console\\.|logger\\.|print|println' . --exclude-dir=node_modules --exclude-dir=.git",
              excerpt: `${artifact.path}: ${loggedSecret}`,
              artifactRefs: [artifact.path],
              observedAt: context.observedAt,
            }),
          ],
        }),
      );
    }

    const leakedLine = SECRET_PATTERNS.map((pattern) =>
      lineWithMatch(artifact.contents, pattern),
    ).find((line): line is string => Boolean(line));
    if (leakedLine) {
      findings.push(
        makeFinding({
          context,
          code: "secret_in_client",
          title: "Secret-like literal is present in generated code",
          severity: "critical",
          hardCapGrade: "F",
          evidence: [
            makeEvidence({
              replayCmd:
                "grep -RInE '(gh[pousr]_|github_pat_|sk-|AKIA|api[_-]?key|token|secret|password)' . --exclude-dir=node_modules --exclude-dir=.git",
              excerpt: `${artifact.path}: ${leakedLine}`,
              artifactRefs: [artifact.path],
              observedAt: context.observedAt,
            }),
          ],
        }),
      );
    }
  }
  return findings;
}
