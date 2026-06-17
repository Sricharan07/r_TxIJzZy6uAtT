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
    options?: { timeoutMs?: number },
  ): ReturnType<AgentTask["sandbox"]["exec"]>;
}

export interface CliAgentSpec {
  displayName: string;
  binary: string;
  commandEnv: string;
  buildCommand(prompt: string): string;
}

export class AgentCliUnavailableError extends Error {}
export class AgentCliRunError extends Error {
  constructor(
    message: string,
    readonly partial: { tokens: number; steps: number; timeout: boolean },
  ) {
    super(message);
  }
}

export async function emitEvent(
  task: AgentTask,
  events: AgentEvent[],
  event: AgentEvent,
): Promise<void> {
  events.push(event);
  await task.onEvent?.(event);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function contentText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((item) => {
    const itemRecord = record(item);
    const text = textValue(itemRecord?.text) ?? textValue(itemRecord?.content);
    return text ? [text] : [];
  });
  return parts.join("\n").trim() || null;
}

function toolInputText(input: unknown): string | null {
  const inputRecord = record(input);
  if (!inputRecord) return null;
  return textValue(inputRecord.command)
    ?? textValue(inputRecord.file_path)
    ?? textValue(inputRecord.path)
    ?? textValue(inputRecord.url)
    ?? textValue(inputRecord.pattern);
}

function claudeToolUseEvent(content: Record<string, unknown>, elapsedSec: number): AgentEvent | null {
  const name = textValue(content.name) ?? "tool";
  const text = toolInputText(content.input) ?? name;
  if (name === "Bash") return { t: elapsedSec, kind: "command", text };
  if (["Edit", "Write", "MultiEdit", "Read", "LS", "Glob", "Grep"].includes(name)) {
    return { t: elapsedSec, kind: name === "Read" || name === "LS" || name === "Glob" || name === "Grep" ? "info" : "file", text };
  }
  if (name === "WebFetch") return { t: elapsedSec, kind: "api", text };
  return { t: elapsedSec, kind: "api", text: `${name}: ${text}` };
}

function resultEvent(text: string, isError: boolean, elapsedSec: number): AgentEvent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^\(bash completed with no output\)$/i.test(trimmed)) {
    return { t: elapsedSec, kind: "info", text: "Command completed with no output" };
  }
  const failedExit = /^exit code\s+([1-9]\d*)/i.test(trimmed);
  return {
    t: elapsedSec,
    kind: isError || failedExit ? "fail" : "info",
    text: trimmed.slice(0, 1_500),
  };
}

function normalizedEvent(value: unknown, elapsedSec: number): AgentEvent | null {
  const object = record(value);
  if (!object) return null;
  const type = textValue(object.type);
  const subtype = textValue(object.subtype);
  if (type === "system" && subtype === "thinking_tokens") return null;
  if (type === "system" && subtype === "init") return { t: elapsedSec, kind: "info", text: "Agent session initialized" };
  if (type === "turn.completed") return { t: elapsedSec, kind: "info", text: "Agent turn completed" };

  const item = record(object.item);
  if (item?.type === "command_execution") {
    return { t: elapsedSec, kind: "command", text: textValue(item.command) ?? "command execution" };
  }
  if (item?.type === "file_change") {
    return { t: elapsedSec, kind: "file", text: textValue(item.path) ?? "file changed" };
  }

  const message = record(object.message);
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      const entryRecord = record(entry);
      if (!entryRecord) continue;
      if (entryRecord.type === "tool_use") return claudeToolUseEvent(entryRecord, elapsedSec);
      if (entryRecord.type === "tool_result") {
        return resultEvent(contentText(entryRecord.content) ?? "", entryRecord.is_error === true, elapsedSec);
      }
      if (entryRecord.type === "text") {
        const text = textValue(entryRecord.text);
        if (text) return { t: elapsedSec, kind: "info", text: text.slice(0, 1_500) };
      }
    }
  }

  const directText = contentText(content) ?? textValue(object.text) ?? textValue(object.message);
  if (directText) return resultEvent(directText, object.is_error === true || subtype === "error", elapsedSec);
  return null;
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
      const event = normalizedEvent(parsed, elapsedSec);
      if (event) events.push(event);
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
  const timeoutMs = Math.max(1, Math.ceil(task.config.metadata.timeoutSec * 1_000));
  const sandbox = task.sandbox;
  const streaming = canStream(sandbox);
  const result = streaming
    ? await sandbox.execStreaming(command, undefined, async (stream, line) => {
        if (stream !== "stdout") return;
        const next = normalizedEvents(line, Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
        normalized.tokens = Math.max(normalized.tokens, next.tokens);
        for (const event of next.events) await emitEvent(task, events, event);
      }, { timeoutMs })
    : await sandbox.exec(command, undefined, { timeoutMs });
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
    throw new AgentCliRunError(`${spec.displayName} CLI exited with code ${result.code}.`, {
      tokens: normalized.tokens,
      steps: events.filter((event) => event.kind === "command" || event.kind === "file" || event.kind === "api").length,
      timeout: /command timed out|timed out|timeout/i.test(result.stderr),
    });
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
