/**
 * Firecracker microVM sandbox (Decision 2).
 *
 * Implements the grader's {@link SandboxHandle} so the same handle the agent
 * mutates is later inspected during grading. The class also models the microVM
 * lifecycle the production runner manages:
 *
 *   boot()      — start a Firecracker microVM from a prebuilt rootfs + kernel,
 *                 attach a tap network device, and wait for the guest agent to
 *                 come up. Each run gets a fresh, isolated VM (Decision 2).
 *   exec()      — run a command in the guest via the vsock/SSH control channel.
 *   readFile()  — `cat` a file from the guest filesystem.
 *   httpGet()   — issue a GET reachable from inside the guest network.
 *   teardown()  — kill the VM process and reclaim the tap device + rootfs.
 *
 * PRODUCTION boots a real microVM (firecracker-microvm) per run for hard
 * isolation and a clean filesystem. THIS IMPLEMENTATION IS SIMULATED and runs
 * entirely in-process: there is no VM, no real shell, and no network. It keeps
 * an in-memory virtual filesystem the agent adapters can "write" to and returns
 * deterministic, clearly-stubbed results so the runner and grader pipeline can
 * be exercised end-to-end without infra. Nothing here claims real execution.
 */
import type { SandboxHandle, ExecResult, HttpResult } from "@kiln/grader";

/** Lifecycle state of the (simulated) microVM. */
type VmState = "created" | "booted" | "torn-down";

export class FirecrackerSandbox implements SandboxHandle {
  private state: VmState = "created";

  /**
   * Simulated guest filesystem: path → contents. In production this lives in
   * the microVM's rootfs; here it is an in-memory map that agent adapters and
   * context ingestion can populate.
   */
  private readonly files = new Map<string, string>();

  /**
   * @param id Deterministic sandbox id (derived from the run config upstream),
   *           used for log correlation. No randomness.
   */
  constructor(public readonly id: string) {}

  /**
   * Boot the microVM (SIMULATED).
   *
   * PRODUCTION: spawn `firecracker` with a kernel + rootfs, configure the tap
   * device, and block until the guest control channel answers a health ping.
   */
  async boot(): Promise<void> {
    // Simulated boot: just transition state. Seed a couple of baseline files so
    // `ls`/`cat` style probes have something to find.
    this.files.set("package.json", '{\n  "name": "agent-workspace",\n  "version": "0.0.0"\n}\n');
    this.state = "booted";
  }

  /** Write a file into the (simulated) guest FS. Used by adapters/ingestion. */
  async writeFile(path: string, contents: string): Promise<void> {
    this.assertBooted();
    this.files.set(path, contents);
  }

  async exec(cmd: string, cwd?: string): Promise<ExecResult> {
    this.assertBooted();
    // SIMULATED command execution. We special-case a few common probes so the
    // grader's shell assertions get plausible, deterministic results; anything
    // else returns a stubbed non-zero result that is honestly labelled.
    const where = cwd ? ` (cwd=${cwd})` : "";

    if (cmd.startsWith("ls")) {
      return { stdout: [...this.files.keys()].join("\n") + "\n", stderr: "", code: 0 };
    }
    if (cmd.startsWith("cat ")) {
      const path = cmd.slice(4).trim();
      const found = this.files.get(path);
      return found != null
        ? { stdout: found, stderr: "", code: 0 }
        : { stdout: "", stderr: `cat: ${path}: No such file or directory\n`, code: 1 };
    }
    // `node <file>` / `python <file>`: succeeds iff the entry file exists in the
    // (simulated) FS, so a "node test.js" assertion passes only when the agent
    // actually produced test.js.
    const runMatch = cmd.match(/^(?:node|python3?|ts-node)\s+(\S+)/);
    if (runMatch) {
      const file = runMatch[1]!;
      return this.files.has(file)
        ? { stdout: `[simulated] ran ${file} → exit 0\n`, stderr: "", code: 0 }
        : { stdout: "", stderr: `Error: Cannot find module '${file}'\n`, code: 1 };
    }
    // Common package-manager probes succeed deterministically (no real network).
    if (/^(npm|pnpm|yarn|npx)\b/.test(cmd)) {
      return { stdout: `[simulated] ${cmd} → ok\n`, stderr: "", code: 0 };
    }
    return {
      stdout: "",
      stderr: `[simulated sandbox] command not executed${where}: ${cmd}\n`,
      code: 127,
    };
  }

  async readFile(path: string): Promise<string | null> {
    this.assertBooted();
    return this.files.has(path) ? (this.files.get(path) as string) : null;
  }

  async httpGet(url: string): Promise<HttpResult> {
    this.assertBooted();
    // SIMULATED network: no real request is made. Return a deterministic
    // "service not running" style response so HTTP assertions resolve cleanly.
    return {
      status: 0,
      body: `[simulated sandbox] no service answered GET ${url}\n`,
    };
  }

  /**
   * Tear down the microVM (SIMULATED).
   *
   * PRODUCTION: SIGKILL the firecracker process, release the tap device, and
   * delete the ephemeral rootfs overlay.
   */
  async teardown(): Promise<void> {
    this.files.clear();
    this.state = "torn-down";
  }

  private assertBooted(): void {
    if (this.state !== "booted") {
      throw new Error(`Sandbox ${this.id} is "${this.state}", expected "booted". Call boot() first.`);
    }
  }
}
