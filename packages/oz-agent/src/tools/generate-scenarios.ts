import type { Assertion, OzProductProfile, OzScenario, ProductEnvRequirement } from "@kiln/shared";
import { evidence, type OzTool } from "./contracts.js";

interface GenerateScenariosInput {
  profile: OzProductProfile;
  userGoal?: string;
}

function baseAssertions(): Assertion[] {
  return [
    { type: "file", name: "Integration entrypoint exists", config: { path: "src/index.mjs" } },
    { type: "shell", name: "Project command succeeds", config: { command: "node src/index.mjs" } },
  ];
}

function nodeEntrypointTask(task: string): string {
  return [
    "Create `src/index.mjs` as the runnable Node entrypoint for this scenario.",
    "The entrypoint must run with `node src/index.mjs` from the project root.",
    "Write any observed product response or validation result to `src/oz-result.json`.",
    task,
  ].join(" ");
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
    const hasSdk = profile.sdks.length > 0;
    const hasApi = profile.APIs.length > 0 || profile.productType.includes("api") || profile.auth !== undefined;
    const scenarios: OzScenario[] = [
      scenario(
        "first_successful_call",
        "First successful call",
        "Every integration starts with installing the SDK or calling the API successfully.",
        nodeEntrypointTask(hasSdk
          ? `Build a minimal Node integration for ${product}. Use the documented SDK ${profile.sdks[0]?.packageName}, initialize the client with documented environment variables, make the simplest safe successful call or local dry-run, and write the observed result to src/oz-result.json.`
          : `Build a minimal Node integration for ${product} using the documented HTTP API or curl examples. Do not search package registries unless the docs name an SDK. Initialize request headers from environment variables and make the simplest safe successful call or local dry-run.`),
        env,
        profile.evidence[0]?.quote ?? "Product docs were discovered.",
      ),
    ];
    if (hasSdk) {
      scenarios.push(scenario(
        "sdk_import_init",
        "SDK import and client initialization",
        "Agents often fail before business logic when install/import/auth docs are unclear.",
        nodeEntrypointTask(`Import the documented ${product} SDK or client, initialize it with environment variables, and export a small reusable client factory. Use only SDK packages found in the provided product profile.`),
        env,
      ));
    } else if (hasApi) {
      scenarios.push(scenario(
        "http_client_init",
        "HTTP client initialization",
        "REST-only products should be tested through documented endpoints and headers instead of invented SDKs.",
        nodeEntrypointTask(`Export a small reusable ${product} HTTP client. Use the documented base URL, version headers, and auth headers from the provided docs. Do not import an SDK unless one is listed in the product profile.`),
        env,
      ));
    }
    if (env.length > 0) {
      scenarios.push(
        scenario(
          "auth_failure_handling",
          "Auth failure handling",
          "A good integration should make missing or invalid credentials obvious without leaking secrets.",
          nodeEntrypointTask(`Add credential validation for ${product}. When required env vars are missing, fail with a clear message that names the variable but never prints the secret value. When env vars are present, run the smallest safe documented call or validation path.`),
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
          nodeEntrypointTask(`Implement a ${product} webhook handler that verifies the documented signature before accepting events. Include a forged-signature negative path.`),
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
          nodeEntrypointTask(`Implement a create workflow for ${product} using an idempotency key if the docs support it, and document how retries are handled.`),
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
          nodeEntrypointTask(`Use ${product} to build the smallest documented retrieval or model workflow. Include cleanup for any created resources.`),
          env,
        ),
      );
    }
    const unique = new Map<string, OzScenario>();
    for (const item of scenarios) unique.set(item.id, item);
    return { scenarios: [...unique.values()].slice(0, 8) };
  },
};
