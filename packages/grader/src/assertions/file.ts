/**
 * File assertion (Decision 16 assertion types; Decision 5 grading).
 *
 * Passes when the file exists, and — if `contains` is set — when its contents
 * include that substring. A missing file is a logical failure (readFile returns
 * null), not an infra error.
 */
import type { FileAssertion, Verdict } from "@kiln/shared";
import type { SandboxHandle } from "../sandbox";

const MAX_OUTPUT = 8_000;

export async function runFileAssertion(
  a: FileAssertion,
  name: string,
  idx: number,
  sandbox: SandboxHandle,
): Promise<Verdict> {
  const contents = await sandbox.readFile(a.path);

  if (contents === null) {
    return {
      assertionIndex: idx,
      type: "file",
      name,
      passed: false,
      output: `File not found: ${a.path}`,
      hint: `Expected the agent to create \`${a.path}\`, but it does not exist.`,
    };
  }

  const containsOk = a.contains ? contents.includes(a.contains) : true;
  const preview =
    contents.length > MAX_OUTPUT ? contents.slice(0, MAX_OUTPUT) + "\n…[truncated]" : contents;

  return {
    assertionIndex: idx,
    type: "file",
    name,
    passed: containsOk,
    output: preview,
    hint: containsOk
      ? undefined
      : `\`${a.path}\` exists but does not contain expected substring "${a.contains}".`,
  };
}
