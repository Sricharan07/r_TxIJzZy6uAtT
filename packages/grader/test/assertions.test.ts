import { describe, it, expect } from "vitest";
import {
  grade,
  runShellAssertion,
  runHttpAssertion,
  runFileAssertion,
  runLlmAssertion,
  HeuristicJudge,
  type SandboxHandle,
} from "../src/index";
import type { Assertion } from "@kiln/shared";

/** In-memory SandboxHandle for grading tests. */
class FakeSandbox implements SandboxHandle {
  files = new Map<string, string>();
  responses = new Map<string, { status: number; body: string }>();
  execImpl: (cmd: string) => { stdout: string; stderr: string; code: number } = () => ({
    stdout: "",
    stderr: "not found",
    code: 127,
  });

  async exec(cmd: string) {
    return this.execImpl(cmd);
  }
  async readFile(path: string) {
    return this.files.has(path) ? (this.files.get(path) as string) : null;
  }
  async httpGet(url: string) {
    return this.responses.get(url) ?? { status: 0, body: "" };
  }
}

describe("runShellAssertion", () => {
  it("passes when the command exits 0", async () => {
    const sb = new FakeSandbox();
    sb.execImpl = () => ({ stdout: "all good", stderr: "", code: 0 });
    const v = await runShellAssertion({ command: "node test.js" }, "tests pass", 0, sb);
    expect(v.passed).toBe(true);
    expect(v.type).toBe("shell");
    expect(v.output).toContain("all good");
    expect(v.hint).toBeUndefined();
  });

  it("fails with a hint when the command exits non-zero", async () => {
    const sb = new FakeSandbox();
    sb.execImpl = () => ({ stdout: "", stderr: "boom", code: 2 });
    const v = await runShellAssertion({ command: "node test.js" }, "tests pass", 1, sb);
    expect(v.passed).toBe(false);
    expect(v.hint).toBeTruthy();
    expect(v.output).toContain("boom");
  });
});

describe("runHttpAssertion", () => {
  it("passes when status matches the default 200", async () => {
    const sb = new FakeSandbox();
    sb.responses.set("http://localhost:3000/health", { status: 200, body: "ok" });
    const v = await runHttpAssertion(
      { url: "http://localhost:3000/health" },
      "health",
      0,
      sb,
    );
    expect(v.passed).toBe(true);
  });

  it("fails when status does not match", async () => {
    const sb = new FakeSandbox();
    sb.responses.set("http://localhost:3000/health", { status: 500, body: "err" });
    const v = await runHttpAssertion(
      { url: "http://localhost:3000/health", expectStatus: 200 },
      "health",
      0,
      sb,
    );
    expect(v.passed).toBe(false);
  });

  it("respects expectBodyContains", async () => {
    const sb = new FakeSandbox();
    sb.responses.set("http://x/", { status: 200, body: "hello world" });
    const ok = await runHttpAssertion(
      { url: "http://x/", expectBodyContains: "world" },
      "body",
      0,
      sb,
    );
    const bad = await runHttpAssertion(
      { url: "http://x/", expectBodyContains: "missing" },
      "body",
      0,
      sb,
    );
    expect(ok.passed).toBe(true);
    expect(bad.passed).toBe(false);
  });
});

describe("runFileAssertion", () => {
  it("passes when the file exists", async () => {
    const sb = new FakeSandbox();
    sb.files.set("src/checkout.ts", "export const x = 1;");
    const v = await runFileAssertion({ path: "src/checkout.ts" }, "exists", 0, sb);
    expect(v.passed).toBe(true);
  });

  it("fails when the file is missing", async () => {
    const sb = new FakeSandbox();
    const v = await runFileAssertion({ path: "src/missing.ts" }, "exists", 0, sb);
    expect(v.passed).toBe(false);
    expect(v.hint).toBeTruthy();
  });

  it("checks `contains`", async () => {
    const sb = new FakeSandbox();
    sb.files.set("src/a.ts", "import { webhooks } from 'sdk'");
    const ok = await runFileAssertion({ path: "src/a.ts", contains: "webhooks" }, "c", 0, sb);
    const bad = await runFileAssertion({ path: "src/a.ts", contains: "registerEndpoint" }, "c", 0, sb);
    expect(ok.passed).toBe(true);
    expect(bad.passed).toBe(false);
  });
});

describe("runLlmAssertion (HeuristicJudge stub)", () => {
  it("returns an llm verdict with reasoning in output", async () => {
    const sb = new FakeSandbox();
    sb.files.set("README.md", "This project follows the SDK recommended patterns for webhooks.");
    const v = await runLlmAssertion(
      { criterion: "Code follows SDK recommended patterns" },
      "patterns",
      0,
      sb,
      new HeuristicJudge(),
    );
    expect(v.type).toBe("llm");
    expect(typeof v.passed).toBe("boolean");
    expect(v.output && v.output.length).toBeTruthy();
  });
});

describe("grade", () => {
  it("returns one verdict per assertion, in order, with matching types", async () => {
    const sb = new FakeSandbox();
    sb.files.set("src/index.ts", "ok");
    sb.execImpl = () => ({ stdout: "", stderr: "", code: 0 });
    sb.responses.set("http://localhost:3000/health", { status: 200, body: "ok" });

    const assertions: Assertion[] = [
      { type: "file", name: "file", config: { path: "src/index.ts" } },
      { type: "shell", name: "shell", config: { command: "node test.js" } },
      { type: "http", name: "http", config: { url: "http://localhost:3000/health" } },
      { type: "llm", name: "llm", config: { criterion: "looks good" } },
    ];

    const verdicts = await grade(assertions, sb);
    expect(verdicts).toHaveLength(4);
    expect(verdicts.map((v) => v.type)).toEqual(["file", "shell", "http", "llm"]);
    expect(verdicts.map((v) => v.assertionIndex)).toEqual([0, 1, 2, 3]);
    expect(verdicts[0]!.passed).toBe(true);
    expect(verdicts[1]!.passed).toBe(true);
    expect(verdicts[2]!.passed).toBe(true);
  });
});
