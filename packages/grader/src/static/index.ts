import type { EvalConfig, Finding } from "@kiln/shared";
import type { SandboxHandle } from "../sandbox.js";
import { runAuthSchemeGrader } from "./auth-scheme.js";
import { runIdempotencyGrader } from "./idempotency.js";
import { runSdkImportGrader } from "./sdk-import.js";
import { runSecretLeakGrader } from "./secret-leak.js";
import { collectStaticArtifacts, type StaticGrader, type StaticGraderContext } from "./shared.js";
import { runWebhookSignatureGrader } from "./webhook-signature.js";

const STATIC_GRADERS: StaticGrader[] = [
  runSecretLeakGrader,
  runSdkImportGrader,
  runAuthSchemeGrader,
  runWebhookSignatureGrader,
  runIdempotencyGrader,
];

export async function runStaticGraders({
  runId,
  taskSpecId,
  config,
  sandbox,
  observedAt,
  artifacts,
}: {
  runId: string;
  taskSpecId: string;
  config: EvalConfig;
  sandbox: SandboxHandle;
  observedAt: string;
  artifacts?: Awaited<ReturnType<typeof collectStaticArtifacts>>;
}): Promise<Finding[]> {
  const collectedArtifacts = artifacts ?? await collectStaticArtifacts(config, sandbox);
  const context: StaticGraderContext = {
    runId,
    taskSpecId,
    config,
    sandbox,
    artifacts: collectedArtifacts,
    observedAt,
  };
  const findingGroups = await Promise.all(STATIC_GRADERS.map((grader) => grader(context)));
  return findingGroups.flat();
}

export type { StaticArtifact, StaticGrader, StaticGraderContext } from "./shared.js";
export { collectStaticArtifacts } from "./shared.js";
