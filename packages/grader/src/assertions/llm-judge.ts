/**
 * LLM-judge assertion (Decision 16 assertion types; Decision 5 grading).
 *
 * For "soft" criteria that cannot be checked mechanically (e.g. "the README
 * clearly explains how to run the project"), we ask an LLM to judge. In
 * production this calls the Anthropic Messages API with the criterion plus a
 * bundle of run artifacts and parses a pass/fail + reasoning.
 *
 * `AnthropicJudge` calls the Messages API when `ANTHROPIC_API_KEY` and
 * `KILN_LLM_JUDGE_MODEL` are configured. When no provider is configured, the
 * assertion is marked unsatisfied with explicit evidence instead of using a
 * heuristic substitute.
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
  if (!apiKey) return new UnconfiguredJudge();
  const model = process.env.KILN_LLM_JUDGE_MODEL;
  if (!model) {
    throw new Error("KILN_LLM_JUDGE_MODEL is required when ANTHROPIC_API_KEY is configured.");
  }
  return new AnthropicJudge(apiKey, model);
}

/** Honest no-provider implementation used when LLM judging is not configured. */
export class UnconfiguredJudge implements LlmJudge {
  async judge(
    _criterion: string,
    artifacts: string,
  ): Promise<{ passed: boolean; reasoning: string }> {
    return {
      passed: false,
      reasoning:
        `LLM judge is not configured, so this advisory assertion was not evaluated. ` +
        `Configure ANTHROPIC_API_KEY and KILN_LLM_JUDGE_MODEL to enable it. ` +
        `Collected ${artifacts.trim().length} chars of artifacts.`,
    };
  }
}

const JUDGE_PATH_LIMIT = 24;
const JUDGE_FILE_LIMIT = 6_000;
const JUDGE_TOTAL_LIMIT = 24_000;

function judgeCandidatePaths(findOutput: string): string[] {
  const common = [
    "src/index.mjs",
    "src/index.js",
    "src/index.ts",
    "src/app.mjs",
    "src/app.js",
    "src/app.ts",
    "src/server.js",
    "src/server.ts",
    "src/webhook.js",
    "src/webhook.ts",
    "package.json",
    "README.md",
  ];
  const found = findOutput
    .split("\n")
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter(Boolean);
  return [...new Set([...common, ...found])]
    .filter((path) => /\.(?:[cm]?[jt]sx?|mjs|cjs|py|go|json|md)$/.test(path))
    .slice(0, JUDGE_PATH_LIMIT);
}

function clipBundle(parts: string[]): string {
  const bundle = parts.join("\n\n");
  return bundle.length > JUDGE_TOTAL_LIMIT ? `${bundle.slice(0, JUDGE_TOTAL_LIMIT)}\n...[truncated]` : bundle;
}

/** Gather source and package artifacts so the judge can inspect implementation, not only README text. */
async function gatherArtifacts(_criterion: string, sandbox: SandboxHandle): Promise<string> {
  const parts: string[] = [];
  const find = await sandbox.exec(
    "find . -maxdepth 5 -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.py' -o -name '*.go' -o -name 'package.json' -o -name 'README.md' \\) -not -path './node_modules/*' -not -path './.git/*' -not -path './dist/*' -not -path './.next/*'",
  );
  for (const path of judgeCandidatePaths(find.code === 0 ? find.stdout : "")) {
    const contents = await sandbox.readFile(path);
    if (contents) parts.push(`--- ${path} ---\n${contents.slice(0, JUDGE_FILE_LIMIT)}`);
  }
  if (parts.length === 0) parts.push("No conventional judge artifacts were available.");
  return clipBundle(parts);
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
