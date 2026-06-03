import { describe, expect, it } from "vitest";
import type { Assertion } from "@kiln/shared";
import { grade } from "./grader";
import type { SandboxHandle, ExecResult, HttpResult } from "./sandbox";
import { AnthropicJudge } from "./assertions/llm-judge";

class FakeSandbox implements SandboxHandle {
  async exec(cmd: string): Promise<ExecResult> {
    return cmd === "npm test"
      ? { stdout: "ok\n", stderr: "", code: 0 }
      : { stdout: "", stderr: "missing\n", code: 1 };
  }

  async readFile(path: string): Promise<string | null> {
    return path === "src/index.ts" ? "export const ok = true;" : null;
  }

  async httpGet(url: string): Promise<HttpResult> {
    return url.endsWith("/health")
      ? { status: 200, body: "healthy" }
      : { status: 404, body: "not found" };
  }
}

describe("grade", () => {
  it("runs shell, http, file, and llm assertions independently", async () => {
    const assertions: Assertion[] = [
      { type: "shell", name: "test command", config: { command: "npm test" } },
      { type: "http", name: "health", config: { url: "http://localhost/health" } },
      { type: "file", name: "source exists", config: { path: "src/index.ts", contains: "ok" } },
      { type: "llm", name: "mentions ok", config: { criterion: "README explains ok behavior" } },
      { type: "file", name: "missing file", config: { path: "missing.ts" } },
    ];

    const verdicts = await grade(assertions, new FakeSandbox());

    expect(verdicts).toHaveLength(5);
    expect(verdicts.slice(0, 3).every((v) => v.passed)).toBe(true);
    expect(verdicts[3]?.type).toBe("llm");
    expect(verdicts[4]?.passed).toBe(false);
    expect(verdicts[4]?.hint).toContain("does not exist");
  });

  it("propagates sandbox transport failures for platform classification", async () => {
    class BrokenSandbox extends FakeSandbox {
      override async readFile(): Promise<string | null> {
        throw new Error("sandbox manager unavailable");
      }
    }

    await expect(
      grade([{ type: "file", name: "source exists", config: { path: "src/index.ts" } }], new BrokenSandbox()),
    ).rejects.toThrow("sandbox manager unavailable");
  });
});

describe("AnthropicJudge", () => {
  it("parses the configured provider verdict", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return Response.json({
        content: [{ type: "text", text: '{"passed":true,"reasoning":"Uses the recommended pattern."}' }],
      });
    }) as typeof fetch;

    const result = await new AnthropicJudge("test-key", "test-model", fetchImpl).judge(
      "Uses recommended SDK patterns",
      "README artifact",
    );

    expect(result).toEqual({ passed: true, reasoning: "Uses the recommended pattern." });
    expect(requests[0]?.headers).toMatchObject({
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
    });
    expect(requests[0]?.body).toContain('"model":"test-model"');
  });
});
