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
  return {
    task: scenario.task,
    language: language as Language,
    productProfile: mergedProfile,
    context: state.discovery.codeExamples.slice(0, 6).map((example) => ({
      type: "paste",
      label: `Example from ${example.sourceUrl}`,
      content: example.code,
    })),
    assertions: scenario.assertions,
    dynamicProbes: scenario.dynamicProbes,
    metadata: {
      agentType,
      timeoutSec: 420,
      requestedRuns,
    },
  };
}
