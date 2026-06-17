import type { OzProductProfile, OzScenario, OzVerification } from "@kiln/shared";
import type { OzTool } from "./contracts.js";

interface VerifySuiteInput {
  profile: OzProductProfile;
  scenarios: OzScenario[];
}

const UNSAFE = /\b(rm\s+-rf\s+\/|drop\s+database|delete\s+from\s+\w+\s*;|real\s+charge|send\s+email|production)\b/i;

function assertionWeak(scenario: OzScenario): string[] {
  const weak: string[] = [];
  if (scenario.assertions.length < 2) weak.push(`${scenario.title}: fewer than two assertions.`);
  if (scenario.assertions.every((assertion) => assertion.type === "llm")) {
    weak.push(`${scenario.title}: only LLM assertions.`);
  }
  return weak;
}

export const verifySuiteTool: OzTool<VerifySuiteInput, { verification: OzVerification }> = {
  name: "verify_suite",
  description: "Verify schema, runnable requirements, missing secrets, weak assertions, hallucination risks, and destructive risks.",
  inputSchema: { type: "object", required: ["profile", "scenarios"] },
  outputSchema: { type: "object" },
  async execute(input) {
    const missingSecrets = input.profile.requiredEnv
      .filter((env) => env.required !== false && !process.env[env.name])
      .map((env) => env.name);
    const weakAssertions = input.scenarios.flatMap(assertionWeak);
    const destructiveRisks = input.scenarios
      .flatMap((scenario) => [
        ...scenario.setupSteps.map((step) => `${scenario.title}: ${step.command}`),
        ...scenario.cleanupSteps.map((step) => `${scenario.title}: ${step.command}`),
        scenario.task,
      ])
      .filter((text) => UNSAFE.test(text));
    const hallucinationRisks = input.profile.sdks.length === 0 && input.profile.productType.includes("sdk")
      ? ["Product classified as SDK but no SDK package was found."]
      : [];
    return {
      verification: {
        schemaValid: input.scenarios.length > 0 && input.scenarios.every((scenario) => scenario.title && scenario.task),
        runnable: destructiveRisks.length === 0 && weakAssertions.length === 0,
        missingSecrets,
        weakAssertions,
        hallucinationRisks,
        destructiveRisks,
      },
    };
  },
};
