/**
 * LLM-judge assertion (Decision 16 assertion types; Decision 5 grading).
 *
 * For "soft" criteria that cannot be checked mechanically (e.g. "the README
 * clearly explains how to run the project"), we ask an LLM to judge. In
 * production this calls the Anthropic Messages API with the criterion plus a
 * bundle of run artifacts and parses a pass/fail + reasoning.
 *
 * `AnthropicJudge` calls the Messages API when `ANTHROPIC_API_KEY` and
 * `KILN_LLM_JUDGE_MODEL` are configured. `HeuristicJudge` remains an explicit
 * local-development fallback when no provider credentials are present.
 *
 * `Verdict.output` is set to the judge's reasoning.
 */
import type { LlmAssertion, Verdict } from "@kiln/shared";
import type { SandboxHandle } from "../sandbox.js";

/** The seam a real Anthropic-backed judge implements. */
export interface LlmJudge {
  /**
   * Judge whether `artifacts` satisfy `criterion`.
   * @param criterion human-language pass condition from the eval author
   * @param artifacts text bundle (file contents, command output) to judge against
   */
  judge(criterion: string, artifacts: string): Promise<{ passed: boolean; reasoning: string }>;
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
}

interface JudgePayload {
  passed: boolean;
  reasoning: string;
}

function parseJudgePayload(text: string): JudgePayload {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const json = JSON.parse((fenced ?? text).trim()) as Partial<JudgePayload>;
  if (typeof json.passed !== "boolean" || typeof json.reasoning !== "string") {
    throw new Error("Anthropic judge returned an invalid verdict payload.");
  }
  return { passed: json.passed, reasoning: json.reasoning };
}

/** Anthropic Messages API implementation used in configured environments. */
export class AnthropicJudge implements LlmJudge {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiUrl = "https://api.anthropic.com/v1/messages",
  ) {}

  async judge(criterion: string, artifacts: string): Promise<JudgePayload> {
    const response = await this.fetchImpl(this.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 600,
        system:
          "You grade coding-agent artifacts. Return only JSON with keys passed (boolean) and reasoning (string). Judge only from the supplied artifacts.",
        messages: [
          {
            role: "user",
            content: `Criterion:\n${criterion}\n\nArtifacts:\n${artifacts}`,
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`Anthropic judge request failed: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as AnthropicResponse;
    const text = data.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    if (!text) throw new Error("Anthropic judge returned no text content.");
    return parseJudgePayload(text);
  }
}

export function createDefaultLlmJudge(): LlmJudge {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new HeuristicJudge();
  const model = process.env.KILN_LLM_JUDGE_MODEL;
  if (!model) {
    throw new Error("KILN_LLM_JUDGE_MODEL is required when ANTHROPIC_API_KEY is configured.");
  }
  return new AnthropicJudge(apiKey, model);
}

/**
 * Deterministic fallback judge (STUB — no real LLM reasoning).
 *
 * Heuristic: pass when the artifact bundle is non-trivial and mentions at least
 * one significant word from the criterion. This is intentionally simple and
 * fully deterministic so runs are reproducible without network/API keys.
 */
export class HeuristicJudge implements LlmJudge {
  async judge(
    criterion: string,
    artifacts: string,
  ): Promise<{ passed: boolean; reasoning: string }> {
    const text = artifacts.toLowerCase();
    const keywords = criterion
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3);

    const hits = keywords.filter((w) => text.includes(w));
    const hasSubstance = artifacts.trim().length >= 40;
    const passed = hasSubstance && (keywords.length === 0 || hits.length > 0);

    const reasoning =
      `[stub heuristic judge — not a real LLM judgement] ` +
      `Matched ${hits.length}/${keywords.length} criterion keyword(s) ` +
      `in ${artifacts.trim().length} chars of artifacts. ` +
      (passed
        ? `Treating criterion as plausibly satisfied.`
        : `Insufficient evidence that the criterion is satisfied.`);

    return { passed, reasoning };
  }
}

/**
 * Gather a small artifact bundle for the judge to look at. Kept deliberately
 * minimal for the MVP: the task summary plus any agent-produced report file if
 * present. A real implementation would assemble the diff and key outputs.
 */
async function gatherArtifacts(criterion: string, sandbox: SandboxHandle): Promise<string> {
  const parts: string[] = [`CRITERION: ${criterion}`];
  // Best-effort: include a conventional output file if the agent wrote one.
  const readme = await sandbox.readFile("README.md");
  if (readme) parts.push(`--- README.md ---\n${readme.slice(0, 4_000)}`);
  return parts.join("\n\n");
}

export async function runLlmAssertion(
  a: LlmAssertion,
  name: string,
  idx: number,
  sandbox: SandboxHandle,
  judge: LlmJudge = createDefaultLlmJudge(),
): Promise<Verdict> {
  const artifacts = await gatherArtifacts(a.criterion, sandbox);
  const { passed, reasoning } = await judge.judge(a.criterion, artifacts);

  return {
    assertionIndex: idx,
    type: "llm",
    name,
    passed,
    output: reasoning,
    hint: passed ? undefined : `LLM judge was not satisfied that: "${a.criterion}".`,
  };
}
