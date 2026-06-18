import type { Assertion, DynamicProbe, OzProductProfile, OzScenario } from "@kiln/shared";
import type { OzTool } from "./contracts.js";

interface GenerateAssertionsInput {
  profile: OzProductProfile;
  scenarios: OzScenario[];
}

function sdkAssertion(profile: OzProductProfile, required: boolean): Assertion | null {
  const sdk = profile.sdks.find((item) => item.language === "node");
  if (!sdk) return null;
  return {
    type: "shell",
    name: `Official SDK is referenced: ${sdk.packageName}`,
    config: { command: `grep -R "${sdk.packageName.replace(/"/g, "\\\"")}" package.json src README.md 2>/dev/null` },
    required,
    severityOnFail: required ? "high" : "low",
    frictionCode: "sdk_not_referenced",
    canHardCap: required,
    codeVsNoCode: "code",
  };
}

function isSecretLikeEnv(name: string): boolean {
  return /(KEY|TOKEN|SECRET|PASSWORD|BEARER|AUTH|CREDENTIAL)/i.test(name);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function grepLiteralAssertion(name: string, value: string): Assertion {
  return {
    type: "shell",
    name,
    config: { command: `grep -R -F -- ${shellSingleQuote(value)} src README.md package.json 2>/dev/null` },
    required: false,
    severityOnFail: "low",
    frictionCode: "documented_surface_not_referenced",
    canHardCap: false,
    codeVsNoCode: "mixed",
  };
}

function documentedSurfaceAssertions(profile: OzProductProfile): Assertion[] {
  const surfaces = new Set<string>();
  for (const api of profile.APIs) {
    if (!api.path || api.path === "/") continue;
    try {
      const url = new URL(api.path);
      surfaces.add(url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`);
      surfaces.add(url.pathname);
    } catch {
      surfaces.add(api.path);
    }
  }
  const candidates = [...surfaces]
    .filter((item) => item.length >= 4 && !/^https?:\/\/[^/]+\/?$/i.test(item))
    .slice(0, 2);
  return candidates.map((item) => grepLiteralAssertion(`Documented product surface is referenced: ${item}`, item));
}

function secretLeakAssertions(profile: OzProductProfile): Assertion[] {
  return profile.requiredEnv.filter((env) => isSecretLikeEnv(env.name)).map((env) => ({
    type: "shell" as const,
    name: `Secret is not printed: ${env.name}`,
    config: {
      command: `sh -c 'value=$(printenv ${env.name}); [ -z "$value" ] || ! grep -R -F --exclude-dir=node_modules --exclude=package-lock.json -- "$value" . 2>/dev/null'`,
    },
  }));
}

function scenarioAssertions(profile: OzProductProfile, scenario: OzScenario): Assertion[] {
  const assertions = [...scenario.assertions];
  const sdk = sdkAssertion(profile, scenario.id.includes("sdk"));
  if (sdk) assertions.push(sdk);
  if (scenario.id === "first_successful_call" || scenario.id.includes("http")) {
    assertions.push(...documentedSurfaceAssertions(profile));
  }
  assertions.push(...secretLeakAssertions(profile));
  if (scenario.id.includes("auth")) {
    assertions.push({
      type: "shell",
      name: "Missing credential path is documented",
      config: { command: "grep -R \"missing\\|required\\|API\" src README.md 2>/dev/null" },
    });
  }
  if (scenario.id.includes("webhook")) {
    assertions.push({
      type: "shell",
      name: "Webhook signature verification is implemented",
      config: { command: "grep -R \"signature\\|verify\" src README.md 2>/dev/null" },
    });
  }
  if (scenario.id.includes("idempot")) {
    assertions.push({
      type: "shell",
      name: "Idempotency is handled",
      config: { command: "grep -R \"idempot\" src README.md 2>/dev/null" },
    });
  }
  assertions.push({
    type: "llm",
    name: "Implementation follows documented product patterns",
    config: { criterion: "The implementation uses documented product APIs and does not invent unsupported methods." },
  });
  return assertions;
}

function dynamicProbesFor(scenario: OzScenario): DynamicProbe[] {
  if (!scenario.id.includes("webhook")) return scenario.dynamicProbes;
  return [
    ...scenario.dynamicProbes,
    {
      name: "Forged webhook request must not succeed",
      url: "http://localhost:3000/webhook",
      method: "POST",
      headers: { "content-type": "application/json", "x-oz-forged-signature": "forged" },
      body: JSON.stringify({ id: "evt_oz_forged", type: "test.event" }),
      expectStatusMin: 400,
      expectStatusMax: 499,
      codeOnFail: "webhook_signature_not_verified",
      severityOnFail: "critical",
      canHardCap: true,
      hardCapGrade: "C-",
    },
  ];
}

export const generateAssertionsTool: OzTool<GenerateAssertionsInput, { scenarios: OzScenario[]; assertions: Assertion[]; dynamicProbes: DynamicProbe[] }> = {
  name: "generate_assertions",
  description: "Turn scenarios into deterministic file, shell, HTTP, static, and advisory assertions.",
  inputSchema: { type: "object", required: ["profile", "scenarios"] },
  outputSchema: { type: "object" },
  async execute(input) {
    const scenarios = input.scenarios.map((scenario) => ({
      ...scenario,
      assertions: scenarioAssertions(input.profile, scenario),
      dynamicProbes: dynamicProbesFor(scenario),
    }));
    return {
      scenarios,
      assertions: scenarios.flatMap((scenario) => scenario.assertions),
      dynamicProbes: scenarios.flatMap((scenario) => scenario.dynamicProbes),
    };
  },
};
