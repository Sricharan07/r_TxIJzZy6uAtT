import type { Finding } from "@kiln/shared";
import {
  contextText,
  makeEvidence,
  makeFinding,
  sourceArtifacts,
  type StaticArtifact,
  type StaticGraderContext,
} from "./shared.js";

function requiresIdempotency(text: string): boolean {
  return (
    /\bidempotenc/i.test(text) ||
    /\bpayment intent\b/i.test(text) ||
    /\bcheckout\b/i.test(text) ||
    /\bcharge\b/i.test(text)
  );
}

function moneyMovementLineIndex(artifact: StaticArtifact): number {
  return artifact.contents
    .split("\n")
    .findIndex((line) =>
      /createPaymentIntent|paymentIntents?\.create|charges?\.create|checkout\.sessions?\.create|createCharge|chargeCustomer/i.test(
        line,
      ),
    );
}

function hasNearbyIdempotency(contents: string, lineIndex: number): boolean {
  const lines = contents.split("\n");
  const start = Math.max(0, lineIndex - 5);
  const end = Math.min(lines.length, lineIndex + 6);
  return /\bidempotenc/i.test(lines.slice(start, end).join("\n"));
}

export async function runIdempotencyGrader(
  context: StaticGraderContext,
): Promise<Finding[]> {
  if (!requiresIdempotency(contextText(context.config))) return [];
  const candidate = sourceArtifacts(context.artifacts)
    .map((artifact) => ({ artifact, lineIndex: moneyMovementLineIndex(artifact) }))
    .find((item) => item.lineIndex >= 0);
  if (!candidate || hasNearbyIdempotency(candidate.artifact.contents, candidate.lineIndex)) return [];

  return [
    makeFinding({
      context,
      code: "no_idempotency",
      title: "Money-moving request is missing an idempotency key",
      severity: "critical",
      evidence: [
        makeEvidence({
          replayCmd:
            "grep -RInE 'idempotenc|paymentIntent|paymentIntents|charge|checkout.sessions' . --exclude-dir=node_modules --exclude-dir=.git",
          excerpt: `${candidate.artifact.path}: money-moving API call found without nearby idempotency handling.`,
          artifactRefs: [candidate.artifact.path],
          observedAt: context.observedAt,
        }),
      ],
    }),
  ];
}
