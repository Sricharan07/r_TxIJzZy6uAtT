/**
 * Shell assertion (Decision 16 assertion types; Decision 5 grading).
 *
 * Runs a command inside the finished sandbox. The assertion passes iff the
 * command exits 0. Combined stdout+stderr is captured into `output` so the
 * report can show what happened; a hint is attached on failure.
 */
import type { ShellAssertion, Verdict } from "@kiln/shared";
import type { SandboxHandle } from "../sandbox.js";

/** Cap captured output so a runaway command cannot bloat the run record. */
const MAX_OUTPUT = 8_000;

function combine(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim()) parts.push(stdout.trimEnd());
  if (stderr.trim()) parts.push("[stderr]\n" + stderr.trimEnd());
  const joined = parts.join("\n");
  return joined.length > MAX_OUTPUT
    ? joined.slice(0, MAX_OUTPUT) + "\n…[truncated]"
    : joined;
}

export async function runShellAssertion(
  a: ShellAssertion,
  name: string,
  idx: number,
  sandbox: SandboxHandle,
): Promise<Verdict> {
  const { stdout, stderr, code } = await sandbox.exec(a.command, a.cwd);
  const passed = code === 0;
  return {
    assertionIndex: idx,
    type: "shell",
    name,
    passed,
    output: combine(stdout, stderr),
    hint: passed
      ? undefined
      : `Command exited ${code}. Check that \`${a.command}\` succeeds in the agent's working tree.`,
  };
}
