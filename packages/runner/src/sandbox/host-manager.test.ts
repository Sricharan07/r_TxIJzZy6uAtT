import { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FirecrackerSandbox } from "./firecracker";
import type { HttpRequest } from "@kiln/grader";
import { createHostManagerServer, type FirecrackerDriver } from "./host-manager";

class FakeDriver implements FirecrackerDriver {
  readonly calls: string[] = [];

  async boot(id: string): Promise<string> {
    this.calls.push(`boot:${id}`);
    return id;
  }
  async writeFile(id: string, path: string): Promise<void> {
    this.calls.push(`write:${id}:${path}`);
  }
  async exec(id: string, cmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
    this.calls.push(`exec:${id}:${cmd}`);
    return { stdout: "ok", stderr: "", code: 0 };
  }
  async execStreaming(
    id: string,
    cmd: string,
    _cwd: string | undefined,
    onLine: (stream: "stdout" | "stderr", line: string) => void | Promise<void>,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    this.calls.push(`stream:${id}:${cmd}`);
    await onLine("stdout", "first");
    return { stdout: "first\n", stderr: "", code: 0 };
  }
  async readFile(id: string, path: string): Promise<string | null> {
    this.calls.push(`read:${id}:${path}`);
    return "readme";
  }
  async httpGet(id: string, url: string): Promise<{ status: number; body: string }> {
    return this.httpRequest(id, { url });
  }
  async httpRequest(id: string, request: HttpRequest): Promise<{ status: number; body: string }> {
    this.calls.push(`http:${id}:${request.method ?? "GET"}:${request.url}`);
    return { status: 200, body: "healthy" };
  }
  async teardown(id: string): Promise<void> {
    this.calls.push(`teardown:${id}`);
  }
}

describe("Firecracker host manager API", () => {
  const servers: ReturnType<typeof createHostManagerServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("serves the sandbox client contract through an authenticated HTTP boundary", async () => {
    const driver = new FakeDriver();
    const server = createHostManagerServer(driver, "secret");
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const sandbox = new FirecrackerSandbox("run-1", `http://127.0.0.1:${port}`, "secret");

    await sandbox.boot();
    await sandbox.writeFile("README.md", "hello");
    expect(await sandbox.exec("npm test")).toMatchObject({ code: 0 });
    const lines: string[] = [];
    expect(await sandbox.execStreaming("npm test", undefined, (_stream, line) => {
      lines.push(line);
    })).toMatchObject({
      code: 0,
    });
    expect(lines).toEqual(["first"]);
    expect(await sandbox.readFile("README.md")).toBe("readme");
    expect(await sandbox.httpGet("https://api.example/health")).toMatchObject({ status: 200 });
    expect(await sandbox.httpRequest({ url: "https://api.example/webhook", method: "POST", body: "{}" })).toMatchObject({ status: 200 });
    await sandbox.teardown();

    expect(driver.calls).toEqual([
      "boot:run-1",
      "write:run-1:README.md",
      "exec:run-1:npm test",
      "stream:run-1:npm test",
      "read:run-1:README.md",
      "http:run-1:GET:https://api.example/health",
      "http:run-1:POST:https://api.example/webhook",
      "teardown:run-1",
    ]);
  });
});
