/**
 * Sandbox implementations (Decision 2).
 *
 * Production runners use a Firecracker host manager. The manager owns the
 * Linux/KVM-specific work: booting a fresh microVM, configuring its network,
 * forwarding guest-agent commands, and reclaiming the VM. Local development
 * uses an explicit temporary-directory sandbox with the same lifecycle.
 */
import { exec as execCb, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SandboxHandle, ExecResult, HttpResult } from "@kiln/grader";

const exec = promisify(execCb);
type SandboxState = "created" | "booted" | "torn-down";

export interface RunnerSandbox extends SandboxHandle {
  readonly id: string;
  boot(): Promise<void>;
  writeFile(path: string, contents: string): Promise<void>;
  execStreaming(cmd: string, cwd: string | undefined, onLine: ExecLineHandler): Promise<ExecResult>;
  teardown(): Promise<void>;
}

export type ExecStream = "stdout" | "stderr";
export type ExecLineHandler = (stream: ExecStream, line: string) => void | Promise<void>;

function runStreamingCommand(
  cmd: string,
  cwd: string,
  onLine: ExecLineHandler,
  timeoutMs = 30_000,
): Promise<ExecResult> {
  return new Promise((resolveResult) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let callbacks = Promise.resolve();
    const pending: Record<ExecStream, string> = { stdout: "", stderr: "" };

    const emit = (stream: ExecStream, line: string): void => {
      callbacks = callbacks.then(() => onLine(stream, line.replace(/\r$/, "")));
    };
    const ingest = (stream: ExecStream, chunk: Buffer): void => {
      const text = chunk.toString();
      if (stream === "stdout") stdout += text;
      else stderr += text;
      pending[stream] += text;
      const lines = pending[stream].split("\n");
      pending[stream] = lines.pop() ?? "";
      for (const line of lines) emit(stream, line);
    };
    const flush = (): void => {
      for (const stream of ["stdout", "stderr"] as const) {
        if (pending[stream]) emit(stream, pending[stream]);
      }
    };
    const settle = (code: number, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      flush();
      void callbacks.then(
        () =>
          resolveResult({
            stdout,
            stderr: stderr || error?.message || (timedOut ? "Command timed out." : ""),
            code,
          }),
        (callbackError: unknown) =>
          resolveResult({
            stdout,
            stderr: callbackError instanceof Error ? callbackError.message : String(callbackError),
            code: 1,
          }),
      );
    };

    child.stdout.on("data", (chunk: Buffer) => ingest("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => ingest("stderr", chunk));
    child.once("error", (error) => settle(1, error));
    child.once("close", (code) => settle(code ?? 1));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
  });
}

/** Local-only sandbox used when `KILN_SANDBOX_MODE=local` (the default). */
export class LocalSandbox implements RunnerSandbox {
  private state: SandboxState = "created";
  private rootDir: string | null = null;

  constructor(public readonly id: string) {}

  async boot(): Promise<void> {
    this.rootDir = await mkdtemp(join(tmpdir(), `kiln-${this.id}-`));
    await this.writeFile("package.json", '{\n  "name": "agent-workspace",\n  "version": "0.0.0"\n}\n');
    this.state = "booted";
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const fullPath = this.resolveGuestPath(path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents);
  }

  async exec(cmd: string, cwd?: string): Promise<ExecResult> {
    this.assertBooted();
    try {
      const result = await exec(cmd, {
        cwd: cwd ? this.resolveGuestPath(cwd) : this.requireRootDir(),
        timeout: 30_000,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (err) {
      const failed = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failed.stdout ?? "",
        stderr: failed.stderr ?? String(err),
        code: typeof failed.code === "number" ? failed.code : 1,
      };
    }
  }

  async execStreaming(cmd: string, cwd: string | undefined, onLine: ExecLineHandler): Promise<ExecResult> {
    this.assertBooted();
    return runStreamingCommand(cmd, cwd ? this.resolveGuestPath(cwd) : this.requireRootDir(), onLine);
  }

  async readFile(path: string): Promise<string | null> {
    this.assertBooted();
    try {
      return await readFile(this.resolveGuestPath(path), "utf8");
    } catch {
      return null;
    }
  }

  async httpGet(url: string): Promise<HttpResult> {
    this.assertBooted();
    try {
      const res = await fetch(url);
      return { status: res.status, body: await res.text() };
    } catch (err) {
      return { status: 0, body: err instanceof Error ? err.message : String(err) };
    }
  }

  async teardown(): Promise<void> {
    if (this.rootDir) {
      await rm(this.rootDir, { recursive: true, force: true });
      this.rootDir = null;
    }
    this.state = "torn-down";
  }

  private assertBooted(): void {
    if (this.state !== "booted") {
      throw new Error(`Sandbox ${this.id} is "${this.state}", expected "booted". Call boot() first.`);
    }
  }

  private requireRootDir(): string {
    if (!this.rootDir) throw new Error(`Sandbox ${this.id} has no root directory.`);
    return this.rootDir;
  }

  private resolveGuestPath(path: string): string {
    const root = this.requireRootDir();
    const fullPath = resolve(root, path);
    if (fullPath !== root && !fullPath.startsWith(root + "/")) {
      throw new Error(`Sandbox path escapes root: ${path}`);
    }
    return fullPath;
  }
}

interface ManagerBootResponse {
  sandboxId: string;
}

/**
 * Production Firecracker sandbox client. Each API call targets a host manager
 * that performs the corresponding action inside one isolated microVM.
 */
export class FirecrackerSandbox implements RunnerSandbox {
  private state: SandboxState = "created";
  private remoteId: string | null = null;
  private readonly baseUrl: string;

  constructor(
    public readonly id: string,
    managerUrl = process.env.KILN_FIRECRACKER_MANAGER_URL,
    private readonly token = process.env.KILN_FIRECRACKER_MANAGER_TOKEN,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!managerUrl) {
      throw new Error("KILN_FIRECRACKER_MANAGER_URL is required in Firecracker sandbox mode.");
    }
    this.baseUrl = managerUrl.replace(/\/$/, "");
  }

  async boot(): Promise<void> {
    const response = await this.request<ManagerBootResponse>("/v1/sandboxes", {
      method: "POST",
      body: JSON.stringify({ sandboxId: this.id }),
    });
    this.remoteId = response.sandboxId;
    this.state = "booted";
  }

  async writeFile(path: string, contents: string): Promise<void> {
    await this.request(this.path("/files"), {
      method: "PUT",
      body: JSON.stringify({ path, contents }),
    });
  }

  async exec(cmd: string, cwd?: string): Promise<ExecResult> {
    return this.request<ExecResult>(this.path("/exec"), {
      method: "POST",
      body: JSON.stringify({ cmd, cwd }),
    });
  }

  async execStreaming(cmd: string, cwd: string | undefined, onLine: ExecLineHandler): Promise<ExecResult> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    const path = this.path("/exec-stream");
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cmd, cwd }),
    });
    if (!response.ok) {
      throw new Error(`Firecracker manager POST ${path} failed: ${response.status} ${await response.text()}`);
    }
    if (!response.body) throw new Error("Firecracker manager returned an empty exec stream.");

    let pending = "";
    let result: ExecResult | undefined;
    const consume = async (line: string): Promise<void> => {
      if (!line) return;
      const message = JSON.parse(line) as {
        stream?: ExecStream;
        line?: string;
        result?: ExecResult;
        error?: string;
      };
      if (message.error) throw new Error(message.error);
      if (message.result) result = message.result;
      else if (message.stream && typeof message.line === "string") await onLine(message.stream, message.line);
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) await consume(line);
      if (done) break;
    }
    await consume(pending);
    if (!result) throw new Error("Firecracker manager exec stream ended without a result.");
    return result;
  }

  async readFile(path: string): Promise<string | null> {
    const response = await this.request<{ contents: string | null }>(
      `${this.path("/files")}?path=${encodeURIComponent(path)}`,
    );
    return response.contents;
  }

  async httpGet(url: string): Promise<HttpResult> {
    return this.request<HttpResult>(this.path("/http-get"), {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  }

  async teardown(): Promise<void> {
    if (this.state === "booted") {
      await this.request(this.path(""), { method: "DELETE" });
    }
    this.remoteId = null;
    this.state = "torn-down";
  }

  private path(suffix: string): string {
    if (this.state !== "booted" || !this.remoteId) {
      throw new Error(`Sandbox ${this.id} is "${this.state}", expected "booted". Call boot() first.`);
    }
    return `/v1/sandboxes/${encodeURIComponent(this.remoteId)}${suffix}`;
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new Error(`Firecracker manager ${init.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

export function createSandbox(id: string): RunnerSandbox {
  const mode = process.env.KILN_SANDBOX_MODE ?? "local";
  if (mode === "local") return new LocalSandbox(id);
  if (mode === "firecracker") return new FirecrackerSandbox(id);
  throw new Error(`Unknown KILN_SANDBOX_MODE "${mode}". Expected "local" or "firecracker".`);
}
