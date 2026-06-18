import type { AgentType, EvalConfig, Language, OzAgentState, OzScenario, ProductEnvRequirement, ProductProfile } from "@kiln/shared";
import { productProfileToEvalProfile } from "./tools/classify-product.js";

export function ozProductToRunnerProfile(state: OzAgentState): ProductProfile | undefined {
  if (!state.productProfile) return undefined;
  return productProfileToEvalProfile(state.productProfile, state.discovery.selectedDocs);
}

function mergeEnvRequirements(...groups: Array<ProductEnvRequirement[] | undefined>): ProductEnvRequirement[] {
  const byName = new Map<string, ProductEnvRequirement>();
  for (const env of groups.flatMap((group) => group ?? [])) {
    const existing = byName.get(env.name);
    if (!existing) {
      byName.set(env.name, { ...env, scopes: [...env.scopes] });
      continue;
    }
    byName.set(env.name, {
      ...existing,
      required: existing.required !== false || env.required !== false,
      description: existing.description ?? env.description,
      scopes: [...new Set([...existing.scopes, ...env.scopes])],
    });
  }
  return [...byName.values()];
}

export function scenarioToEvalConfig({
  state,
  scenario,
  agentType = "claude-code",
  requestedRuns = 1,
}: {
  state: OzAgentState;
  scenario: OzScenario;
  agentType?: AgentType;
  requestedRuns?: number;
}): EvalConfig {
  const productProfile = ozProductToRunnerProfile(state);
  const language = (state.input.preferredLanguage === "curl" ? "node" : state.input.preferredLanguage) ?? productProfile?.runtime.language ?? "node";
  const mergedProfile: ProductProfile | undefined = productProfile
    ? {
        ...productProfile,
        runtime: { ...productProfile.runtime, language: language as Language },
        requiredEnv: mergeEnvRequirements(productProfile.requiredEnv, scenario.requiredEnv),
        setupSteps: [...(productProfile.setupSteps ?? []), ...scenario.setupSteps],
        cleanupSteps: [...(productProfile.cleanupSteps ?? []), ...scenario.cleanupSteps],
      }
    : undefined;
  const facts = state.productProfile
    ? [
        `Product: ${state.productProfile.productName}`,
        `Types: ${state.productProfile.productType.join(", ") || "unknown"}`,
        `Auth scheme: ${state.productProfile.auth?.scheme ?? "unknown"}`,
        `Auth header: ${state.productProfile.auth?.headerName ?? "not documented"}`,
        `Required env: ${mergeEnvRequirements(state.productProfile.requiredEnv, scenario.requiredEnv).map((env) => env.name).join(", ") || "none detected"}`,
        `Documented SDKs: ${state.productProfile.sdks.map((sdk) => [
          `${sdk.manager}:${sdk.packageName}`,
          sdk.symbols?.length ? `symbols=${sdk.symbols.join("|")}` : "",
          sdk.methods?.length ? `methods=${sdk.methods.slice(0, 8).join("|")}` : "",
        ].filter(Boolean).join(" ")).join(", ") || "none"}`,
        `Documented APIs: ${state.productProfile.APIs.map((api) => [api.method, api.path || api.name].filter(Boolean).join(" ")).join("; ") || "none mapped"}`,
        "Instruction: Use only documented SDKs listed above. If none are listed, use the documented HTTP API/curl examples and do not search package registries.",
      ].join("\n")
    : "";
  return {
    task: scenario.task,
    language: language as Language,
    productProfile: mergedProfile,
    context: [
      ...(facts ? [{ type: "paste" as const, label: "Oz product integration facts", content: facts }] : []),
      ...state.discovery.codeExamples.slice(0, 6).map((example) => ({
        type: "paste" as const,
        label: `Example from ${example.sourceUrl}`,
        content: example.code,
      })),
    ],
    assertions: scenario.assertions,
    dynamicProbes: scenario.dynamicProbes,
    metadata: {
      agentType,
      timeoutSec: 420,
      requestedRuns,
      productSecretSourceJobId: state.jobId,
    },
  };
}
