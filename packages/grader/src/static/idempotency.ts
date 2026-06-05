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

function createsMoneyMovement(artifact: StaticArtifact): boolean {
  return /createPaymentIntent|paymentIntents?\.create|charges?\.create|checkout\.sessions?\.create|createCharge|chargeCustomer/i.test(
    artifact.contents,
  );
}

function hasIdempotency(contents: string): boolean {
  return /\bidempotenc/i.test(contents);
}

export async function runIdempotencyGrader(
  context: StaticGraderContext,
): Promise<Finding[]> {
  if (!requiresIdempotency(contextText(context.config))) return [];
  const artifact = sourceArtifacts(context.artifacts).find(createsMoneyMovement);
  if (!artifact || hasIdempotency(artifact.contents)) return [];

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
          excerpt: `${artifact.path}: money-moving API call found without idempotency handling.`,
          artifactRefs: [artifact.path],
          observedAt: context.observedAt,
        }),
      ],
    }),
  ];
}
