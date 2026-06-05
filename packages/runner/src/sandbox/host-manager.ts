/**
 * Linux/KVM Firecracker host manager (Decision 2).
 *
 * Run this service on a metal host. It boots one fresh microVM per eval,
 * exposes the narrow API consumed by `FirecrackerSandbox`, and tears each VM
 * down after grading. The rootfs must start sshd and include curl/base64.
 * Host-level forwarding/NAT policy is provisioned outside this process.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult, HttpRequest, HttpResult } from "@kiln/grader";

interface BootedVm {
  id: string;
  tapName: string;
  guestIp: string;
  socketPath: string;
  rootDir: string;
  process: ChildProcess;
}

export interface FirecrackerDriver {
  boot(id: string): Promise<string>;
  writeFile(id: string, path: string, contents: string): Promise<void>;
  exec(id: string, cmd: string, cwd?: string): Promise<ExecResult>;
  execStreaming(id: string, cmd: string, cwd: string | undefined, onLine: ExecLineHandler): Promise<ExecResult>;
  readFile(id: string, path: string): Promise<string | null>;
  httpRequest(id: string, request: HttpRequest): Promise<HttpResult>;
  httpGet(id: string, url: string): Promise<HttpResult>;
  teardown(id: string): Promise<void>;
}

export interface FirecrackerHostConfig {
  firecrackerBin: string;
  kernelImagePath: string;
  rootfsPath: string;
  sshKeyPath: string;
  workDir: string;
  listenHost: string;
  listenPort: number;
  token?: string;
  bootTimeoutMs: number;
  memoryMib: number;
  vcpuCount: number;
}

interface CommandResult extends ExecResult {}
type ExecStream = "stdout" | "stderr";
type ExecLineHandler = (stream: ExecStream, line: string) => void | Promise<void>;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runFile(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve();
    });
  });
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs = 30_000,
  onLine?: ExecLineHandler,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let callbacks = Promise.resolve();
    const pending: Record<ExecStream, string> = { stdout: "", stderr: "" };
    const emit = (stream: ExecStream, line: string): void => {
      if (onLine) callbacks = callbacks.then(() => onLine(stream, line.replace(/\r$/, "")));
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
    const settle = (code: number, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const stream of ["stdout", "stderr"] as const) {
        if (pending[stream]) emit(stream, pending[stream]);
      }
      void callbacks.then(
        () => resolve({ stdout, stderr: stderr || error?.message || (timedOut ? "Command timed out." : ""), code }),
        (callbackError: unknown) =>
          resolve({ stdout, stderr: callbackError instanceof Error ? callbackError.message : String(callbackError), code: 1 }),
      );
    };
    child.stdout.on("data", (chunk: Buffer) => {
      ingest("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      ingest("stderr", chunk);
    });
    child.on("error", (err) => {
      settle(1, err);
    });
    child.on("close", (code) => {
      settle(code ?? 1);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firecrackerRequest(socketPath: string, method: string, path: string, body: unknown): Promise<void> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method,
        path,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString();
        });
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 300) {
            reject(new Error(`Firecracker ${method} ${path} failed: ${res.statusCode} ${responseBody}`));
          } else {
            resolve();
          }
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

export class ProcessFirecrackerDriver implements FirecrackerDriver {
  private readonly vms = new Map<string, BootedVm>();
  private slot = 1;

  constructor(private readonly config: FirecrackerHostConfig) {}

  async boot(id: string): Promise<string> {
    if (this.vms.has(id)) throw new Error(`Sandbox "${id}" already exists.`);
    const slot = this.slot++;
    const tapName = `kiln${slot.toString(16)}`.slice(0, 15);
    const subnet = 30 + (slot % 190);
    const hostIp = `172.30.${subnet}.1`;
    const guestIp = `172.30.${subnet}.2`;
    const rootDir = await mkdtemp(join(this.config.workDir, `kiln-${id}-`));
    const rootfsPath = join(rootDir, basename(this.config.rootfsPath));
    const socketPath = join(rootDir, "firecracker.sock");
    await copyFile(this.config.rootfsPath, rootfsPath);

    let process: ChildProcess | null = null;
    try {
      await runFile("ip", ["tuntap", "add", "dev", tapName, "mode", "tap"]);
      await runFile("ip", ["addr", "add", `${hostIp}/30`, "dev", tapName]);
      await runFile("ip", ["link", "set", "dev", tapName, "up"]);
      process = spawn(this.config.firecrackerBin, ["--api-sock", socketPath], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      process.stderr?.on("data", (chunk: Buffer) => {
        console.error(`[firecracker:${id}] ${chunk.toString().trimEnd()}`);
      });
      await this.waitForSocket(socketPath);
      const bootArgs =
        `console=ttyS0 reboot=k panic=1 pci=off ` +
        `ip=${guestIp}::${hostIp}:255.255.255.252::eth0:off`;
      await firecrackerRequest(socketPath, "PUT", "/boot-source", {
        kernel_image_path: this.config.kernelImagePath,
        boot_args: bootArgs,
      });
      await firecrackerRequest(socketPath, "PUT", "/drives/rootfs", {
        drive_id: "rootfs",
        path_on_host: rootfsPath,
        is_root_device: true,
        is_read_only: false,
      });
      await firecrackerRequest(socketPath, "PUT", "/network-interfaces/eth0", {
        iface_id: "eth0",
        guest_mac: `06:00:ac:1e:${subnet.toString(16).padStart(2, "0")}:02`,
        host_dev_name: tapName,
      });
      await firecrackerRequest(socketPath, "PUT", "/machine-config", {
        vcpu_count: this.config.vcpuCount,
        mem_size_mib: this.config.memoryMib,
      });
      await firecrackerRequest(socketPath, "PUT", "/actions", { action_type: "InstanceStart" });

      const vm = { id, tapName, guestIp, socketPath, rootDir, process };
      this.vms.set(id, vm);
      await this.waitForGuest(vm);
      return id;
    } catch (err) {
      this.vms.delete(id);
      process?.kill("SIGKILL");
      await runFile("ip", ["link", "del", "dev", tapName]).catch(() => {});
      await rm(rootDir, { recursive: true, force: true });
      throw err;
    }
  }

  async writeFile(id: string, path: string, contents: string): Promise<void> {
    const parent = dirname(path);
    const encoded = Buffer.from(contents).toString("base64");
    const result = await this.ssh(id, `mkdir -p ${shellQuote(parent)} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)}`);
    if (result.code !== 0) throw new Error(`Guest file write failed: ${result.stderr}`);
  }

  async exec(id: string, cmd: string, cwd?: string): Promise<ExecResult> {
    return this.ssh(id, cwd ? `cd ${shellQuote(cwd)} && ${cmd}` : cmd);
  }

  async execStreaming(id: string, cmd: string, cwd: string | undefined, onLine: ExecLineHandler): Promise<ExecResult> {
    return this.ssh(id, cwd ? `cd ${shellQuote(cwd)} && ${cmd}` : cmd, undefined, onLine);
  }

  async readFile(id: string, path: string): Promise<string | null> {
    const result = await this.ssh(id, `cat -- ${shellQuote(path)}`);
    if (result.code === 0) return result.stdout;
    if (result.stderr.includes("No such file")) return null;
    throw new Error(`Guest file read failed: ${result.stderr}`);
  }

  async httpGet(id: string, url: string): Promise<HttpResult> {
    return this.httpRequest(id, { url });
  }

  async httpRequest(id: string, request: HttpRequest): Promise<HttpResult> {
    const method = request.method ?? "GET";
    const headers = Object.entries(request.headers ?? {}).flatMap(([name, value]) => [
      "-H",
      `${name}: ${value}`,
    ]);
    const args = [
      "curl",
      "-sS",
      "-L",
      "--max-time",
      "20",
      "-w",
      "\\n%{http_code}",
      "-X",
      method,
      ...headers,
      ...(request.body === undefined ? [] : ["--data-binary", request.body]),
      request.url,
    ];
    const result = await this.ssh(id, args.map(shellQuote).join(" "));
    if (result.code !== 0) return { status: 0, body: result.stderr };
    const boundary = result.stdout.lastIndexOf("\n");
    return {
      status: Number(result.stdout.slice(boundary + 1)) || 0,
      body: boundary >= 0 ? result.stdout.slice(0, boundary) : result.stdout,
    };
  }

  async teardown(id: string): Promise<void> {
    const vm = this.requireVm(id);
    this.vms.delete(id);
    vm.process.kill("SIGKILL");
    await runFile("ip", ["link", "del", "dev", vm.tapName]).catch(() => {});
    await rm(vm.rootDir, { recursive: true, force: true });
  }

  private async waitForSocket(socketPath: string): Promise<void> {
    const deadline = Date.now() + this.config.bootTimeoutMs;
    while (Date.now() < deadline) {
      try {
        await access(socketPath);
        return;
      } catch {
        await sleep(50);
      }
    }
    throw new Error(`Firecracker API socket did not appear: ${socketPath}`);
  }

  private async waitForGuest(vm: BootedVm): Promise<void> {
    const deadline = Date.now() + this.config.bootTimeoutMs;
    while (Date.now() < deadline) {
      if ((await this.ssh(vm.id, "true", vm)).code === 0) return;
      await sleep(250);
    }
    throw new Error(`Guest ${vm.id} did not become reachable at ${vm.guestIp}.`);
  }

  private ssh(id: string, command: string, knownVm?: BootedVm, onLine?: ExecLineHandler): Promise<CommandResult> {
    const vm = knownVm ?? this.requireVm(id);
    return runCommand(
      "ssh",
      [
        "-i",
        this.config.sshKeyPath,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=3",
        `root@${vm.guestIp}`,
        command,
      ],
      30_000,
      onLine,
    );
  }

  private requireVm(id: string): BootedVm {
    const vm = this.vms.get(id);
    if (!vm) throw new Error(`Sandbox "${id}" does not exist.`);
    return vm;
  }
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (body.length > 10 * 1024 * 1024) throw new Error("Request body exceeds 10 MiB.");
  }
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

export function createHostManagerServer(driver: FirecrackerDriver, token?: string): Server {
  return createServer(async (req, res) => {
    try {
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        send(res, 401, { error: "Unauthorized" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://host-manager");
      if (req.method === "POST" && url.pathname === "/v1/sandboxes") {
        const body = await jsonBody(req);
        const sandboxId = String(body.sandboxId ?? "");
        if (!sandboxId) throw new Error("sandboxId is required.");
        send(res, 201, { sandboxId: await driver.boot(sandboxId) });
        return;
      }
      const match = /^\/v1\/sandboxes\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (!match) {
        send(res, 404, { error: "Not found" });
        return;
      }
      const id = decodeURIComponent(match[1]!);
      const action = match[2] ?? "";
      if (req.method === "DELETE" && action === "") {
        await driver.teardown(id);
        send(res, 204);
        return;
      }
      if (req.method === "POST" && action === "/exec") {
        const body = await jsonBody(req);
        send(res, 200, await driver.exec(id, String(body.cmd ?? ""), body.cwd ? String(body.cwd) : undefined));
        return;
      }
      if (req.method === "POST" && action === "/exec-stream") {
        const body = await jsonBody(req);
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        try {
          const result = await driver.execStreaming(
            id,
            String(body.cmd ?? ""),
            body.cwd ? String(body.cwd) : undefined,
            (stream, line) => {
              res.write(`${JSON.stringify({ stream, line })}\n`);
            },
          );
          res.end(`${JSON.stringify({ result })}\n`);
        } catch (err) {
          res.end(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
        }
        return;
      }
      if (req.method === "PUT" && action === "/files") {
        const body = await jsonBody(req);
        await driver.writeFile(id, String(body.path ?? ""), String(body.contents ?? ""));
        send(res, 204);
        return;
      }
      if (req.method === "GET" && action === "/files") {
        send(res, 200, { contents: await driver.readFile(id, url.searchParams.get("path") ?? "") });
        return;
      }
      if (req.method === "POST" && action === "/http-get") {
        const body = await jsonBody(req);
        send(res, 200, await driver.httpRequest(id, {
          url: String(body.url ?? ""),
          method: body.method ? String(body.method) as HttpRequest["method"] : undefined,
          headers: typeof body.headers === "object" && body.headers !== null ? body.headers as Record<string, string> : undefined,
          body: typeof body.body === "string" ? body.body : undefined,
        }));
        return;
      }
      send(res, 404, { error: "Not found" });
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function hostConfigFromEnv(): FirecrackerHostConfig {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  return {
    firecrackerBin: process.env.KILN_FIRECRACKER_BIN ?? "firecracker",
    kernelImagePath: required("KILN_FIRECRACKER_KERNEL"),
    rootfsPath: required("KILN_FIRECRACKER_ROOTFS"),
    sshKeyPath: required("KILN_FIRECRACKER_SSH_KEY"),
    workDir: process.env.KILN_FIRECRACKER_WORK_DIR ?? tmpdir(),
    listenHost: process.env.KILN_FIRECRACKER_MANAGER_HOST ?? "127.0.0.1",
    listenPort: Number(process.env.KILN_FIRECRACKER_MANAGER_PORT ?? 8787),
    token: process.env.KILN_FIRECRACKER_MANAGER_TOKEN,
    bootTimeoutMs: Number(process.env.KILN_FIRECRACKER_BOOT_TIMEOUT_MS ?? 15_000),
    memoryMib: Number(process.env.KILN_FIRECRACKER_MEMORY_MIB ?? 1024),
    vcpuCount: Number(process.env.KILN_FIRECRACKER_VCPU_COUNT ?? 2),
  };
}

export async function startHostManager(config = hostConfigFromEnv()): Promise<Server> {
  await mkdir(config.workDir, { recursive: true });
  const server = createHostManagerServer(new ProcessFirecrackerDriver(config), config.token);
  await new Promise<void>((resolve) => server.listen(config.listenPort, config.listenHost, resolve));
  console.log(`Firecracker host manager listening on http://${config.listenHost}:${config.listenPort}`);
  return server;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  void startHostManager();
}
