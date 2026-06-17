import type { Assertion, OzProductProfile, OzScenario, ProductEnvRequirement } from "@kiln/shared";
import { evidence, type OzTool } from "./contracts.js";

interface GenerateScenariosInput {
  profile: OzProductProfile;
  userGoal?: string;
}

function baseAssertions(): Assertion[] {
  return [
    { type: "file", name: "Integration entrypoint exists", config: { path: "src/index.ts" } },
    { type: "shell", name: "Project command succeeds", config: { command: "npm test || npm run build || node src/index.ts" } },
  ];
}

function scenario(
  id: string,
  title: string,
  rationale: string,
  task: string,
  requiredEnv: ProductEnvRequirement[],
  sources = requiredEnv.length ? requiredEnv[0]?.description ?? rationale : rationale,
): OzScenario {
  return {
    id,
    title,
    rationale,
    task,
    assertions: baseAssertions(),
    dynamicProbes: [],
    requiredEnv,
    setupSteps: [],
    cleanupSteps: [],
    confidence: 0.78,
    sources: [evidence("generated-suite", sources, 0.78)],
    risks: [],
  };
}

export const generateScenariosTool: OzTool<GenerateScenariosInput, { scenarios: OzScenario[] }> = {
  name: "generate_scenarios",
  description: "Generate 3 to 8 realistic integration scenarios with rationale and evidence.",
  inputSchema: { type: "object", required: ["profile"] },
  outputSchema: { type: "object" },
  async execute(input) {
    const profile = input.profile;
    const env = profile.requiredEnv;
    const product = profile.productName;
    const scenarios: OzScenario[] = [
      scenario(
        "first_successful_call",
        "First successful call",
        "Every integration starts with installing the SDK or calling the API successfully.",
        `Build a minimal Node integration for ${product}. Install the official SDK if one is documented, initialize the client, make the simplest safe successful call or local dry-run, and write the observed result to src/oz-result.json.`,
        env,
        profile.evidence[0]?.quote ?? "Product docs were discovered.",
      ),
      scenario(
        "sdk_import_init",
        "SDK import and client initialization",
        "Agents often fail before business logic when install/import/auth docs are unclear.",
        `Create src/index.ts that imports the documented ${product} SDK or client, initializes it with environment variables, and exports a small reusable client factory.`,
        env,
      ),
    ];
    if (env.length > 0) {
      scenarios.push(
        scenario(
          "auth_failure_handling",
          "Auth failure handling",
          "A good integration should make missing or invalid credentials obvious without leaking secrets.",
          `Add credential validation for ${product}. When required env vars are missing, fail with a clear message that names the variable but never prints the secret value.`,
          env,
        ),
      );
    }
    if (profile.webhooks.length > 0 || profile.productType.includes("payments")) {
      scenarios.push(
        scenario(
          "webhook_signature_verification",
          "Webhook signature verification",
          "Webhook-heavy products need deterministic signature verification checks to prevent false-success integrations.",
          `Implement a ${product} webhook handler that verifies the documented signature before accepting events. Include a forged-signature negative path.`,
          env,
        ),
      );
    }
    if (profile.productType.includes("payments") || profile.APIs.some((api) => /idempot/i.test(api.name))) {
      scenarios.push(
        scenario(
          "idempotent_creation",
          "Idempotent creation",
          "Payment-like create operations should avoid duplicate resources on retries.",
          `Implement a create workflow for ${product} using an idempotency key if the docs support it, and document how retries are handled.`,
          env,
        ),
      );
    }
    if (profile.productType.includes("rag") || profile.productType.includes("ai-sdk")) {
      scenarios.push(
        scenario(
          "retrieval_or_model_workflow",
          "Retrieval/model workflow",
          "AI and RAG products need tests that prove the agent used the SDK instead of hand-rolled placeholders.",
          `Use ${product} to build the smallest documented retrieval or model workflow. Save the answer to src/oz-result.json and include cleanup for any created resources.`,
          env,
        ),
      );
    }
    const unique = new Map<string, OzScenario>();
    for (const item of scenarios) unique.set(item.id, item);
    return { scenarios: [...unique.values()].slice(0, 8) };
  },
};
