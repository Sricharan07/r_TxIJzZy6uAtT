import { describe, expect, it } from "vitest";
import type { ExecResult, HttpRequest, HttpResult, SandboxHandle } from "@kiln/grader";
import type { EvalConfig } from "@kiln/shared";
import { ClaudeCodeAgent } from "./claude-code";
import { CodexAgent } from "./codex";
import { getAgent } from "./registry";

const config: EvalConfig = {
  task: "Build an integration",
  language: "node",
  context: [],
  assertions: [],
  metadata: { agentType: "codex", timeoutSec: 30 },
};

class CliSandbox implements SandboxHandle {
  readonly commands: string[] = [];

  async exec(cmd: string): Promise<ExecResult> {
    this.commands.push(cmd);
    if (cmd.startsWith("command -v")) return { stdout: "/usr/local/bin/codex\n", stderr: "", code: 0 };
    return {
      stdout: [
        '{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
      ].join("\n"),
      stderr: "",
      code: 0,
    };
  }

  async readFile(): Promise<string | null> {
    return null;
  }

  async httpRequest(_request: HttpRequest): Promise<HttpResult> {
    return { status: 200, body: "" };
  }

  async httpGet(url: string): Promise<HttpResult> {
    return this.httpRequest({ url });
  }
}

class StreamingCliSandbox extends CliSandbox {
  async execStreaming(
    cmd: string,
    _cwd: string | undefined,
    onLine: (stream: "stdout" | "stderr", line: string) => void | Promise<void>,
  ): Promise<ExecResult> {
    this.commands.push(cmd);
    await onLine("stdout", '{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}');
    await onLine("stdout", '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":8}}');
    return { stdout: "", stderr: "", code: 0 };
  }
}

describe("CLI adapters", () => {
  it("runs Codex inside the sandbox and normalizes JSONL events", async () => {
    const sandbox = new CliSandbox();
    const streamed: string[] = [];
    const result = await new CodexAgent().startTask({
      config,
      sandbox,
      prompt: "Build it",
      async onEvent(event) {
        streamed.push(event.text);
      },
    });

    expect(sandbox.commands[1]).toContain("codex exec --json");
    expect(result.tokens).toBe(15);
    expect(result.events.some((event) => event.kind === "command")).toBe(true);
    expect(streamed).toHaveLength(result.events.length);
  });

  it("emits normalized events as a sandbox streams JSONL output", async () => {
    const sandbox = new StreamingCliSandbox();
    const streamed: string[] = [];
    const result = await new CodexAgent().startTask({
      config,
      sandbox,
      prompt: "Build it",
      async onEvent(event) {
        streamed.push(event.text);
      },
    });

    expect(result.tokens).toBe(20);
    expect(streamed).toContain("npm test");
    expect(result.events.some((event) => event.kind === "command")).toBe(true);
  });

  it("does not classify successful Claude tool results as failures", async () => {
    class ClaudeResultSandbox extends CliSandbox {
      override async execStreaming(
        cmd: string,
        _cwd: string | undefined,
        onLine: (stream: "stdout" | "stderr", line: string) => void | Promise<void>,
      ): Promise<ExecResult> {
        this.commands.push(cmd);
        await onLine("stdout", JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
        }));
        await onLine("stdout", JSON.stringify({
          type: "user",
          message: { content: [{ type: "tool_result", is_error: false, content: "(Bash completed with no output)" }] },
        }));
        await onLine("stdout", JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 10 }));
        return { stdout: "", stderr: "", code: 0 };
      }
    }
    const previousUseCli = process.env.KILN_AGENT_USE_CLI;
    process.env.KILN_AGENT_USE_CLI = "1";
    try {
      const result = await new ClaudeCodeAgent().startTask({
        config,
        sandbox: new ClaudeResultSandbox(),
        prompt: "Build it",
      });

      expect(result.events.some((event) => event.kind === "fail")).toBe(false);
      expect(result.events.map((event) => event.text)).toContain("Command completed with no output");
      expect(result.events.some((event) => event.text.includes("thinking_tokens"))).toBe(false);
    } finally {
      if (previousUseCli === undefined) delete process.env.KILN_AGENT_USE_CLI;
      else process.env.KILN_AGENT_USE_CLI = previousUseCli;
    }
  });

  it("passes the configured Bedrock Claude model to Claude Code", async () => {
    const previousUseCli = process.env.KILN_AGENT_USE_CLI;
    const previousModel = process.env.ANTHROPIC_MODEL;
    process.env.KILN_AGENT_USE_CLI = "1";
    process.env.ANTHROPIC_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    try {
      const sandbox = new CliSandbox();
      await new ClaudeCodeAgent().startTask({
        config,
        sandbox,
        prompt: "Build it",
      });

      expect(sandbox.commands[1]).toContain(
        "--model 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'",
      );
    } finally {
      if (previousUseCli === undefined) delete process.env.KILN_AGENT_USE_CLI;
      else process.env.KILN_AGENT_USE_CLI = previousUseCli;
      if (previousModel === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = previousModel;
    }
  });

  it("forwards product-scoped agent env to CLI adapters", async () => {
    const previous = process.env.KILN_AGENT_PRODUCT_TOKEN;
    process.env.KILN_AGENT_PRODUCT_TOKEN = "agent-env-test";
    try {
      const sandbox = new CliSandbox();
      await new CodexAgent().startTask({
        config: {
          ...config,
          productProfile: {
            companyName: "TestCo",
            productName: "Agent Product",
            productType: "sdk",
            runtime: { language: "node", image: "default" },
            docsSources: [],
            requiredEnv: [
              { name: "KILN_AGENT_PRODUCT_TOKEN", scopes: ["agent"], required: true },
            ],
          },
        },
        sandbox,
        prompt: "Build it",
      });

      expect(sandbox.commands[1]).toContain("KILN_AGENT_PRODUCT_TOKEN='agent-env-test'");
    } finally {
      if (previous === undefined) delete process.env.KILN_AGENT_PRODUCT_TOKEN;
      else process.env.KILN_AGENT_PRODUCT_TOKEN = previous;
    }
  });

  it("registers the Cursor adapter", () => {
    expect(getAgent("cursor").type).toBe("cursor");
  });
});
