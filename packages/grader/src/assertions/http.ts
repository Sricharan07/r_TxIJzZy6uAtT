/**
 * HTTP assertion (Decision 16 assertion types; Decision 5 grading).
 *
 * Issues an HTTP request from inside the sandbox. Passes when the status equals
 * `expectStatus` (default 200) and, if `expectBodyContains` is set, the body
 * contains that substring.
 */
import type { HttpAssertion, Verdict } from "@kiln/shared";
import type { SandboxHandle } from "../sandbox.js";

const MAX_OUTPUT = 8_000;

function clip(body: string): string {
  return body.length > MAX_OUTPUT ? body.slice(0, MAX_OUTPUT) + "\n…[truncated]" : body;
}

export async function runHttpAssertion(
  a: HttpAssertion,
  name: string,
  idx: number,
  sandbox: SandboxHandle,
): Promise<Verdict> {
  const expectStatus = a.expectStatus ?? 200;
  const method = a.method ?? "GET";
  const { status, body } = await sandbox.httpRequest({
    url: a.url,
    method,
    headers: a.headers,
    body: a.body,
  });

  const statusOk = status === expectStatus;
  const bodyOk = a.expectBodyContains ? body.includes(a.expectBodyContains) : true;
  const bodyNotOk = a.expectBodyNotContains ? !body.includes(a.expectBodyNotContains) : true;
  const passed = statusOk && bodyOk && bodyNotOk;

  let hint: string | undefined;
  if (!statusOk) {
    hint = `Expected HTTP ${expectStatus} but got ${status} from ${a.url}.`;
  } else if (!bodyOk) {
    hint = `Response did not contain expected substring "${a.expectBodyContains}".`;
  } else if (!bodyNotOk) {
    hint = `Response contained forbidden substring "${a.expectBodyNotContains}".`;
  }

  return {
    assertionIndex: idx,
    type: "http",
    name,
    passed,
    output: `${method} ${a.url} -> ${status}\n${clip(body)}`,
    hint,
  };
}
