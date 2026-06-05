import type { Finding } from "@kiln/shared";
import {
  contextText,
  makeEvidence,
  makeFinding,
  sourceArtifacts,
  type StaticArtifact,
  type StaticGraderContext,
} from "./shared.js";

function isWebhookTask(text: string): boolean {
  return /\bwebhook(s)?\b/i.test(text);
}

function looksLikeWebhookHandler(artifact: StaticArtifact): boolean {
  return (
    /\bwebhook(s)?\b/i.test(artifact.path) ||
    /\bwebhook(s)?\b/i.test(artifact.contents) ||
    /\bpayment_succeeded\b/i.test(artifact.contents)
  );
}

function verifiesSignature(contents: string): boolean {
  return /constructEvent|verifySignature|webhooks?\.verify|signature|signing[_\s-]?secret|createHmac|timingSafeEqual/i.test(
    contents,
  );
}

export async function runWebhookSignatureGrader(
  context: StaticGraderContext,
): Promise<Finding[]> {
  if (!isWebhookTask(contextText(context.config))) return [];
  const handler = sourceArtifacts(context.artifacts).find(looksLikeWebhookHandler);
  if (!handler || verifiesSignature(handler.contents)) return [];

  return [
    makeFinding({
      context,
      code: "missing_signature_verification",
      title: "Webhook handler does not verify request signatures",
      severity: "critical",
      evidence: [
        makeEvidence({
          replayCmd:
            "grep -RInE 'constructEvent|verifySignature|webhooks?\\.verify|signature|signing[_ -]?secret|createHmac|timingSafeEqual' . --exclude-dir=node_modules --exclude-dir=.git",
          excerpt: `${handler.path}: webhook handler found without signature verification logic.`,
          artifactRefs: [handler.path],
          observedAt: context.observedAt,
        }),
      ],
    }),
  ];
}
