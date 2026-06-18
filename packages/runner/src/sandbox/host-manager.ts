/**
 * Linux/KVM Firecracker host manager (Decision 2).
 *
 * Run this service on a metal host. It boots one fresh microVM per eval,
 * exposes the narrow API consumed by `FirecrackerSandbox`, and tears each VM
 * down after grading. The rootfs must start sshd and include curl/base64.
 * Host-level forwarding/NAT policy is provisioned outside this process.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult, HttpRequest, HttpResult } from "@kiln/grader";
import type { ProductRuntimeImage } from "@kiln/shared";
import { loadDotEnv } from "../env.js";

interface BootedVm {
  id: string;
  runtimeImage: ProductRuntimeImage;
  tapName: string;
  hostIp: string;
  guestIp: string;
  socketPath: string;
  rootDir: string;
  process: ChildProcess;
}

interface FirecrackerBootOptions {
  runtimeImage?: ProductRuntimeImage;
}

export interface FirecrackerDriver {
  boot(id: string, options?: FirecrackerBootOptions): Promise<string>;
  health(): Promise<Record<string, unknown>>;
  writeFile(id: string, path: string, contents: string): Promise<void>;
  exec(id: string, cmd: string, cwd?: string, timeoutMs?: number): Promise<ExecResult>;
  execStreaming(id: string, cmd: string, cwd: string | undefined, onLine: ExecLineHandler, timeoutMs?: number): Promise<ExecResult>;
  readFile(id: string, path: string): Promise<string | null>;
  httpRequest(id: string, request: HttpRequest): Promise<HttpResult>;
  httpGet(id: string, url: string): Promise<HttpResult>;
  teardown(id: string): Promise<void>;
}

export interface FirecrackerHostConfig {
  firecrackerBin: string;
  kernelImagePath: string;
  rootfsPath: string;
  rootfsPaths: Partial<Record<ProductRuntimeImage, string>>;
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
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 3_700_000;
const MAX_FIRECRACKER_SLOTS = 4_096;
const TAP_NAME_PATTERN = /^kiln[0-9a-f]+$/;
const PRODUCT_RUNTIME_IMAGES = new Set<ProductRuntimeImage>([
  "default",
  "ubuntu-22.04-node22",
  "ubuntu-24.04-node22",
  "python",
  "go",
]);
const RUNTIME_IMAGE_ENV_NAMES: Partial<Record<ProductRuntimeImage, string>> = {
  "ubuntu-22.04-node22": "KILN_FIRECRACKER_ROOTFS_UBUNTU_22_04_NODE22",
  "ubuntu-24.04-node22": "KILN_FIRECRACKER_ROOTFS_UBUNTU_24_04_NODE22",
  python: "KILN_FIRECRACKER_ROOTFS_PYTHON",
  go: "KILN_FIRECRACKER_ROOTFS_GO",
};

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
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
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
        () => resolve({ stdout, stderr: [stderr, error?.message, timedOut ? "Command timed out." : ""].filter(Boolean).join("\n"), code }),
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

async function stopProcess(process: ChildProcess | null): Promise<void> {
  if (!process || process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      resolve();
    }, 3_000);
    process.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    process.kill("SIGKILL");
  });
}

function tapNameForSlot(slot: number): string {
  return `kiln${slot.toString(16)}`.slice(0, 15);
}

function networkForSlot(slot: number): { tapName: string; hostIp: string; guestIp: string; guestMac: string } {
  const subnet = 30 + (slot % 190);
  return {
    tapName: tapNameForSlot(slot),
    hostIp: `172.30.${subnet}.1`,
    guestIp: `172.30.${subnet}.2`,
    guestMac: `06:00:ac:1e:${subnet.toString(16).padStart(2, "0")}:02`,
  };
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
  private nextSlot = 1;

  constructor(private readonly config: FirecrackerHostConfig) {}

  private rootfsPathFor(runtimeImage: ProductRuntimeImage | undefined): { runtimeImage: ProductRuntimeImage; rootfsPath: string } {
    const image = runtimeImage && runtimeImage !== "default" ? runtimeImage : "default";
    if (image === "default") return { runtimeImage: "default", rootfsPath: this.config.rootfsPath };
    const configured = this.config.rootfsPaths[image];
    if (configured) return { runtimeImage: image, rootfsPath: configured };
    if (image === "ubuntu-22.04-node22") return { runtimeImage: image, rootfsPath: this.config.rootfsPath };
    const envName = RUNTIME_IMAGE_ENV_NAMES[image] ?? `KILN_FIRECRACKER_ROOTFS_${image.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    throw new Error(`Runtime image "${image}" requires ${envName} to point at a compatible Firecracker rootfs.`);
  }

  async boot(id: string, options: FirecrackerBootOptions = {}): Promise<string> {
    if (this.vms.has(id)) throw new Error(`Sandbox "${id}" already exists.`);
    const selectedRootfs = this.rootfsPathFor(options.runtimeImage);
    await this.ensureHostNetworking();
    await this.reapStaleHostState();
    const { tapName, hostIp, guestIp, guestMac } = await this.allocateNetwork();
    const rootDir = await mkdtemp(join(this.config.workDir, `kiln-${id}-`));
    const rootfsPath = join(rootDir, basename(selectedRootfs.rootfsPath));
    const socketPath = join(rootDir, "firecracker.sock");
    await runFile("cp", ["--sparse=always", selectedRootfs.rootfsPath, rootfsPath]);

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
        guest_mac: guestMac,
        host_dev_name: tapName,
      });
      await firecrackerRequest(socketPath, "PUT", "/machine-config", {
        vcpu_count: this.config.vcpuCount,
        mem_size_mib: this.config.memoryMib,
      });
      await firecrackerRequest(socketPath, "PUT", "/actions", { action_type: "InstanceStart" });

      const vm = { id, runtimeImage: selectedRootfs.runtimeImage, tapName, hostIp, guestIp, socketPath, rootDir, process };
      this.vms.set(id, vm);
      await this.waitForGuest(vm);
      await this.configureGuestNetwork(vm);
      return id;
    } catch (err) {
      this.vms.delete(id);
      await stopProcess(process);
      await runFile("ip", ["link", "del", "dev", tapName]).catch(() => {});
      await rm(rootDir, { recursive: true, force: true });
      throw err;
    }
  }

  async health(): Promise<Record<string, unknown>> {
    await this.reapStaleHostState();
    const tapNames = await this.listKilnTapNames();
    return {
      activeSandboxes: this.vms.size,
      activeTapNames: [...this.vms.values()].map((vm) => vm.tapName),
      activeRuntimeImages: [...this.vms.values()].map((vm) => vm.runtimeImage),
      configuredRuntimeImages: ["default", ...Object.keys(this.config.rootfsPaths)],
      leakedTapNames: tapNames.filter((tapName) => !this.isActiveTap(tapName)),
    };
  }

  async writeFile(id: string, path: string, contents: string): Promise<void> {
    const parent = dirname(path);
    const encoded = Buffer.from(contents).toString("base64");
    const result = await this.ssh(id, `mkdir -p ${shellQuote(parent)} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)}`);
    if (result.code !== 0) throw new Error(`Guest file write failed: ${result.stderr}`);
  }

  async exec(id: string, cmd: string, cwd?: string, timeoutMs?: number): Promise<ExecResult> {
    return this.ssh(id, cwd ? `cd ${shellQuote(cwd)} && ${cmd}` : cmd, undefined, undefined, timeoutMs);
  }

  async execStreaming(id: string, cmd: string, cwd: string | undefined, onLine: ExecLineHandler, timeoutMs?: number): Promise<ExecResult> {
    return this.ssh(id, cwd ? `cd ${shellQuote(cwd)} && ${cmd}` : cmd, undefined, onLine, timeoutMs);
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
    await stopProcess(vm.process);
    await runFile("ip", ["link", "del", "dev", vm.tapName]).catch(() => {});
    await rm(vm.rootDir, { recursive: true, force: true });
  }

  private async allocateNetwork(): Promise<{ tapName: string; hostIp: string; guestIp: string; guestMac: string }> {
    for (let attempt = 0; attempt < MAX_FIRECRACKER_SLOTS; attempt++) {
      const slot = this.nextSlot;
      this.nextSlot = this.nextSlot >= MAX_FIRECRACKER_SLOTS ? 1 : this.nextSlot + 1;
      const network = networkForSlot(slot);
      if (this.isActiveTap(network.tapName)) continue;
      if (await this.tapExists(network.tapName)) {
        await runFile("ip", ["link", "del", "dev", network.tapName]).catch(() => undefined);
        if (await this.tapExists(network.tapName)) continue;
      }
      return network;
    }
    throw new Error("No available Firecracker tap slot.");
  }

  private isActiveTap(tapName: string): boolean {
    return [...this.vms.values()].some((vm) => vm.tapName === tapName);
  }

  private async tapExists(tapName: string): Promise<boolean> {
    return (await runCommand("ip", ["link", "show", "dev", tapName])).code === 0;
  }

  private async listKilnTapNames(): Promise<string[]> {
    const result = await runCommand("ip", ["tuntap", "show"]);
    if (result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.split(":", 1)[0]?.trim() ?? "")
      .filter((name) => TAP_NAME_PATTERN.test(name));
  }

  private async reapStaleHostState(): Promise<void> {
    const activeRootDirs = new Set([...this.vms.values()].map((vm) => vm.rootDir));
    for (const tapName of await this.listKilnTapNames()) {
      if (!this.isActiveTap(tapName)) {
        await runFile("ip", ["link", "del", "dev", tapName]).catch(() => undefined);
      }
    }
    let entries;
    try {
      entries = await readdir(this.config.workDir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("kiln-"))
      .map(async (entry) => {
        const path = join(this.config.workDir, entry.name);
        if (!activeRootDirs.has(path)) await rm(path, { recursive: true, force: true });
      }));
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

  private async configureGuestNetwork(vm: BootedVm): Promise<void> {
    await this.ssh(
      vm.id,
      `ip route replace default via ${shellQuote(vm.hostIp)} dev eth0 || true; ` +
        `printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf`,
      vm,
    );
  }

  private async ensureHostNetworking(): Promise<void> {
    const route = await runCommand("ip", ["route", "show", "default"]);
    const defaultIface = /\bdev\s+(\S+)/.exec(route.stdout)?.[1];
    if (!defaultIface) throw new Error(`Could not determine default network interface: ${route.stderr || route.stdout}`);
    const forward = await runCommand("sysctl", ["-w", "net.ipv4.ip_forward=1"]);
    if (forward.code !== 0) throw new Error(`Could not enable IPv4 forwarding: ${forward.stderr}`);
    await this.ensureIptablesRule(
      ["-t", "nat", "-C", "POSTROUTING", "-s", "172.30.0.0/16", "-o", defaultIface, "-j", "MASQUERADE"],
      ["-t", "nat", "-A", "POSTROUTING", "-s", "172.30.0.0/16", "-o", defaultIface, "-j", "MASQUERADE"],
      `NAT masquerade on ${defaultIface}`,
    );
    await this.ensureIptablesRule(
      ["-C", "FORWARD", "-i", "kiln+", "-o", defaultIface, "-j", "ACCEPT"],
      ["-I", "FORWARD", "1", "-i", "kiln+", "-o", defaultIface, "-j", "ACCEPT"],
      `forwarding from Firecracker taps to ${defaultIface}`,
    );
    await this.ensureIptablesRule(
      ["-C", "FORWARD", "-i", defaultIface, "-o", "kiln+", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
      ["-I", "FORWARD", "1", "-i", defaultIface, "-o", "kiln+", "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
      `return forwarding from ${defaultIface} to Firecracker taps`,
    );
  }

  private async ensureIptablesRule(checkArgs: string[], addArgs: string[], description: string): Promise<void> {
    const check = await runCommand("iptables", checkArgs);
    if (check.code === 0) return;
    const add = await runCommand("iptables", addArgs);
    if (add.code !== 0) throw new Error(`Could not configure ${description}: ${add.stderr}`);
  }

  private ssh(
    id: string,
    command: string,
    knownVm?: BootedVm,
    onLine?: ExecLineHandler,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<CommandResult> {
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
      timeoutMs,
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

function timeoutFromBody(body: Record<string, unknown>): number | undefined {
  const value = body.timeoutMs;
  if (value === undefined) return undefined;
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  return Math.min(Math.floor(timeoutMs), MAX_COMMAND_TIMEOUT_MS);
}

export function createHostManagerServer(driver: FirecrackerDriver, token?: string): Server {
  return createServer(async (req, res) => {
    try {
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        send(res, 401, { error: "Unauthorized" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://host-manager");
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
        send(res, 200, {
          ok: true,
          service: "kiln-firecracker-host-manager",
          checkedAt: new Date().toISOString(),
          diagnostics: await driver.health(),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/sandboxes") {
        const body = await jsonBody(req);
        const sandboxId = String(body.sandboxId ?? "");
        if (!sandboxId) throw new Error("sandboxId is required.");
        const runtimeImage = body.runtimeImage === undefined ? undefined : String(body.runtimeImage);
        if (runtimeImage !== undefined && !PRODUCT_RUNTIME_IMAGES.has(runtimeImage as ProductRuntimeImage)) {
          throw new Error(`Unsupported runtimeImage "${runtimeImage}".`);
        }
        send(res, 201, { sandboxId: await driver.boot(sandboxId, { runtimeImage: runtimeImage as ProductRuntimeImage | undefined }) });
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
        send(res, 200, await driver.exec(id, String(body.cmd ?? ""), body.cwd ? String(body.cwd) : undefined, timeoutFromBody(body)));
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
            timeoutFromBody(body),
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
  const rootfsPaths: Partial<Record<ProductRuntimeImage, string>> = {};
  for (const [image, envName] of Object.entries(RUNTIME_IMAGE_ENV_NAMES) as Array<[ProductRuntimeImage, string]>) {
    if (process.env[envName]) rootfsPaths[image] = process.env[envName];
  }
  return {
    firecrackerBin: process.env.KILN_FIRECRACKER_BIN ?? "firecracker",
    kernelImagePath: required("KILN_FIRECRACKER_KERNEL"),
    rootfsPath: required("KILN_FIRECRACKER_ROOTFS"),
    rootfsPaths,
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
  loadDotEnv();
  void startHostManager();
}
