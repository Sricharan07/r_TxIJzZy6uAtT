import { afterEach, describe, expect, it, vi } from "vitest";
import { createSandbox, FirecrackerSandbox, LocalSandbox } from "./firecracker";

describe("FirecrackerSandbox", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("delegates the microVM lifecycle to the configured host manager", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/v1/sandboxes") && init.method === "POST") {
        return Response.json({ sandboxId: "vm-123" });
      }
      if (url.endsWith("/exec-stream")) {
        return new Response(
          [
            JSON.stringify({ stream: "stdout", line: "first" }),
            JSON.stringify({ result: { stdout: "first\n", stderr: "", code: 0 } }),
            "",
          ].join("\n"),
          { headers: { "Content-Type": "application/x-ndjson" } },
        );
      }
      if (url.endsWith("/exec")) return Response.json({ stdout: "ok", stderr: "", code: 0 });
      if (url.includes("/files?")) return Response.json({ contents: "contents" });
      if (url.endsWith("/http-get")) return Response.json({ status: 200, body: "healthy" });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const sandbox = new FirecrackerSandbox("run-1", "https://manager.example", "token", fetchImpl);
    await sandbox.boot({ runtimeImage: "ubuntu-24.04-node22" });
    await sandbox.writeFile("README.md", "hello");
    expect(await sandbox.exec("npm test", undefined, { timeoutMs: 45_000 })).toEqual({ stdout: "ok", stderr: "", code: 0 });
    const lines: string[] = [];
    expect(await sandbox.execStreaming("npm test", undefined, (_stream, line) => {
      lines.push(line);
    }, { timeoutMs: 90_000 })).toEqual({
      stdout: "first\n",
      stderr: "",
      code: 0,
    });
    expect(lines).toEqual(["first"]);
    expect(await sandbox.readFile("README.md")).toBe("contents");
    expect(await sandbox.httpGet("https://api.example/health")).toEqual({ status: 200, body: "healthy" });
    expect(await sandbox.httpRequest({ url: "https://api.example/webhook", method: "POST", body: "{}" })).toEqual({ status: 200, body: "healthy" });
    await sandbox.teardown();

    expect(calls.map((call) => call.init.method ?? "GET")).toEqual([
      "POST",
      "PUT",
      "POST",
      "POST",
      "GET",
      "POST",
      "POST",
      "DELETE",
    ]);
    expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBe("Bearer token");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      sandboxId: "run-1",
      runtimeImage: "ubuntu-24.04-node22",
    });
    expect(JSON.parse(String(calls[2]?.init.body))).toMatchObject({ timeoutMs: 45_000 });
    expect(JSON.parse(String(calls[3]?.init.body))).toMatchObject({ timeoutMs: 90_000 });
  });

  it("selects the local sandbox by default and Firecracker when configured", () => {
    expect(createSandbox("local")).toBeInstanceOf(LocalSandbox);
    vi.stubEnv("KILN_SANDBOX_MODE", "firecracker");
    vi.stubEnv("KILN_FIRECRACKER_MANAGER_URL", "https://manager.example");
    expect(createSandbox("remote")).toBeInstanceOf(FirecrackerSandbox);
  });

  it("treats remote teardown as complete when the manager already removed the sandbox", async () => {
    const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/v1/sandboxes") && init.method === "POST") {
        return Response.json({ sandboxId: "vm-removed" });
      }
      if (init.method === "DELETE") return new Response("missing", { status: 404 });
      return Response.json({});
    }) as typeof fetch;
    const sandbox = new FirecrackerSandbox("run-removed", "https://manager.example", "token", fetchImpl);

    await sandbox.boot();
    await expect(sandbox.teardown()).resolves.toBeUndefined();
  });

  it("streams local command output line-by-line", async () => {
    const sandbox = new LocalSandbox("stream-local");
    const lines: string[] = [];
    await sandbox.boot();
    try {
      const result = await sandbox.execStreaming("printf 'first\\nsecond\\n'", undefined, (_stream, line) => {
        lines.push(line);
      });
      expect(result).toMatchObject({ code: 0, stdout: "first\nsecond\n" });
      expect(lines).toEqual(["first", "second"]);
    } finally {
      await sandbox.teardown();
    }
  });
});
