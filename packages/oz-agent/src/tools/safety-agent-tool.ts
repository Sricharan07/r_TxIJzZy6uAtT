import type { OzRisk, OzScenario, Severity } from "@kiln/shared";
import { evidence, type OzTool } from "./contracts.js";

interface SafetyInput {
  scenarios: OzScenario[];
}

const BLOCKERS: Array<{ code: string; severity: Severity; pattern: RegExp; message: string }> = [
  { code: "real_charge_risk", severity: "critical", pattern: /\breal\s+(charge|payment|card)\b/i, message: "Suite appears to risk real charges." },
  { code: "prod_data_risk", severity: "critical", pattern: /\bproduction\b.*\b(delete|remove|destroy)\b/i, message: "Suite appears to target production data." },
  { code: "unsafe_shell", severity: "critical", pattern: /rm\s+-rf\s+\/|mkfs|shutdown|reboot/i, message: "Suite contains unsafe shell commands." },
  { code: "spam_risk", severity: "high", pattern: /\bsend\s+(email|sms)\b.*\breal\b/i, message: "Suite may send messages to real users." },
  { code: "private_ip_crawl", severity: "high", pattern: /https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/i, message: "Suite references private network targets." },
];

function inspectText(scenario: OzScenario): string {
  return [
    scenario.task,
    ...scenario.setupSteps.map((step) => step.command),
    ...scenario.cleanupSteps.map((step) => step.command),
    ...scenario.assertions.map((assertion) => JSON.stringify(assertion)),
  ].join("\n");
}

export const safetyAgentTool: OzTool<SafetyInput, { blocked: boolean; risks: OzRisk[] }> = {
  name: "safety_agent",
  description: "Prevent dangerous, destructive, private-network, or unfair test suites.",
  inputSchema: { type: "object", required: ["scenarios"] },
  outputSchema: { type: "object" },
  async execute(input) {
    const risks: OzRisk[] = [];
    for (const scenario of input.scenarios) {
      const text = inspectText(scenario);
      for (const blocker of BLOCKERS) {
        if (!blocker.pattern.test(text)) continue;
        risks.push({
          code: blocker.code,
          severity: blocker.severity,
          message: `${scenario.title}: ${blocker.message}`,
          evidence: [evidence("safety-agent", blocker.message, 0.9)],
        });
      }
    }
    return { blocked: risks.some((risk) => risk.severity === "critical"), risks };
  },
};
