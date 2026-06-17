import type { AgentEvent } from "@kiln/shared";
import type { AgentRun, AgentTask } from "./interface.js";
import { BUILTIN_AGENT_ENV, envPrefix, shellQuote } from "../product-env.js";

export { shellQuote };

type ExecStream = "stdout" | "stderr";
interface StreamingSandbox {
  execStreaming(
    cmd: string,
    cwd: string | undefined,
    onLine: (stream: ExecStream, line: string) => void | Promise<void>,
  ): ReturnType<AgentTask["sandbox"]["exec"]>;
}

export interface CliAgentSpec {
  displayName: string;
  binary: string;
  commandEnv: string;
  buildCommand(prompt: string): string;
}

export class AgentCliUnavailableError extends Error {}

export async function emitEvent(
  task: AgentTask,
  events: AgentEvent[],
  event: AgentEvent,
): Promise<void> {
  events.push(event);
  await task.onEvent?.(event);
}

function nestedText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  for (const key of ["text", "message", "command", "output", "summary", "content", "item", "event", "result", "data"]) {
    const result = nestedText(object[key]);
    if (result) return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = nestedText(item);
      if (result) return result;
    }
  }
  return null;
}

function eventKind(value: unknown): AgentEvent["kind"] {
  const text = JSON.stringify(value).toLowerCase();
  if (text.includes("error") || text.includes("failed")) return "fail";
  if (text.includes("command") || text.includes("shell") || text.includes("exec")) return "command";
  if (text.includes("file") || text.includes("patch") || text.includes("edit")) return "file";
  if (text.includes("tool") || text.includes("api")) return "api";
  if (text.includes("warn")) return "warn";
  return "info";
}

function usageTokens(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const object = value as Record<string, unknown>;
  const direct = ["input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens"]
    .map((key) => object[key])
    .filter((item): item is number => typeof item === "number")
    .reduce((sum, item) => sum + item, 0);
  return direct || Object.values(object).reduce<number>((sum, item) => sum + usageTokens(item), 0);
}

function normalizedEvents(stdout: string, elapsedSec: number): { events: AgentEvent[]; tokens: number } {
  const events: AgentEvent[] = [];
  let tokens = 0;
  for (const line of stdout.split("\n").map((item) => item.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      tokens = Math.max(tokens, usageTokens(parsed));
      events.push({
        t: elapsedSec,
        kind: eventKind(parsed),
        text: nestedText(parsed) ?? line.slice(0, 500),
      });
    } catch {
      events.push({ t: elapsedSec, kind: "info", text: line.slice(0, 500) });
    }
  }
  return { events, tokens };
}

function configuredCommand(spec: CliAgentSpec, prompt: string): string {
  const template = process.env[spec.commandEnv];
  if (!template) return spec.buildCommand(prompt);
  return template.includes("{prompt}")
    ? template.replaceAll("{prompt}", shellQuote(prompt))
    : `${template} ${shellQuote(prompt)}`;
}

function forwardedAgentEnvPrefix(task: AgentTask): string {
  return envPrefix(task.config, "agent", BUILTIN_AGENT_ENV);
}

function canStream(sandbox: AgentTask["sandbox"]): sandbox is AgentTask["sandbox"] & StreamingSandbox {
  return "execStreaming" in sandbox && typeof (sandbox as StreamingSandbox).execStreaming === "function";
}

export async function runCliAgent(task: AgentTask, spec: CliAgentSpec): Promise<AgentRun> {
  const probe = await task.sandbox.exec(`command -v ${shellQuote(spec.binary)}`);
  if (probe.code !== 0) {
    throw new AgentCliUnavailableError(`${spec.displayName} CLI "${spec.binary}" is not installed in the sandbox.`);
  }

  const events: AgentEvent[] = [];
  await emitEvent(task, events, {
    t: 0,
    kind: "info",
    text: `${spec.displayName} session started`,
  });
  const startedAt = Date.now();
  const command = `${forwardedAgentEnvPrefix(task)}${configuredCommand(spec, task.prompt)}`;
  let normalized: ReturnType<typeof normalizedEvents> = { events: [], tokens: 0 };
  const sandbox = task.sandbox;
  const streaming = canStream(sandbox);
  const result = streaming
    ? await sandbox.execStreaming(command, undefined, async (stream, line) => {
        if (stream !== "stdout") return;
        const next = normalizedEvents(line, Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
        normalized.tokens = Math.max(normalized.tokens, next.tokens);
        for (const event of next.events) await emitEvent(task, events, event);
      })
    : await sandbox.exec(command);
  const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  if (!streaming) {
    normalized = normalizedEvents(result.stdout, elapsedSec);
    for (const event of normalized.events) await emitEvent(task, events, event);
  }
  if (result.stderr.trim()) {
    await emitEvent(task, events, {
      t: elapsedSec,
      kind: result.code === 0 ? "warn" : "fail",
      text: result.stderr.trim().slice(0, 1_000),
    });
  }
  if (result.code !== 0) {
    throw new Error(`${spec.displayName} CLI exited with code ${result.code}.`);
  }
  await emitEvent(task, events, {
    t: elapsedSec,
    kind: "info",
    text: `${spec.displayName} session complete`,
  });

  return {
    events,
    tokens: normalized.tokens,
    steps: events.filter((event) => event.kind === "command" || event.kind === "file" || event.kind === "api").length,
    async collectArtifacts(): Promise<void> {},
  };
}
