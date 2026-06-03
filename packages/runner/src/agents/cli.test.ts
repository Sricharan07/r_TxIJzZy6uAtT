import { describe, expect, it } from "vitest";
import type { ExecResult, HttpResult, SandboxHandle } from "@kiln/grader";
import type { EvalConfig } from "@kiln/shared";
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

  async httpGet(): Promise<HttpResult> {
    return { status: 200, body: "" };
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

  it("registers the Cursor adapter", () => {
    expect(getAgent("cursor").type).toBe("cursor");
  });
});
