/**
 * LLM-judge assertion (Decision 16 assertion types; Decision 5 grading).
 *
 * For "soft" criteria that cannot be checked mechanically (e.g. "the README
 * clearly explains how to run the project"), we ask an LLM to judge. In
 * production this calls the Anthropic Messages API with the criterion plus a
 * bundle of run artifacts and parses a pass/fail + reasoning.
 *
 * IMPORTANT — what is real vs simulated here:
 *   - The `LlmJudge` interface is the real seam.
 *   - `HeuristicJudge` is a deterministic STUB used when no API key is
 *     configured (and in this sandbox, where outbound LLM calls are not
 *     available). It does NOT actually reason about the criterion; it applies a
 *     transparent keyword heuristic and labels its reasoning as a stub so
 *     nobody mistakes it for a real judgement.
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
  judge: LlmJudge = new HeuristicJudge(),
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
