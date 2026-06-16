import { loadDotEnv } from "./lib/env.mjs";

loadDotEnv();

const managerUrl = (process.env.KILN_FIRECRACKER_MANAGER_URL ?? "").replace(/\/$/, "");
const token = process.env.KILN_FIRECRACKER_MANAGER_TOKEN ?? "";
const timeoutMs = Number(process.env.KILN_FIRECRACKER_SMOKE_TIMEOUT_MS ?? 120_000);

if (!managerUrl) {
  console.error("KILN_FIRECRACKER_MANAGER_URL is required.");
  process.exit(1);
}
if (!token) {
  console.error("KILN_FIRECRACKER_MANAGER_TOKEN is required.");
  process.exit(1);
}

const sandboxId = `smoke-${Date.now()}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function request(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${managerUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed with ${response.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

try {
  await request("/v1/sandboxes", { method: "POST", body: JSON.stringify({ sandboxId }) });
  await request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/files`, {
    method: "PUT",
    body: JSON.stringify({ path: "kiln-smoke.txt", contents: "kiln-firecracker-ok\n" }),
  });
  const result = await request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`, {
    method: "POST",
    body: JSON.stringify({ cmd: "cat kiln-smoke.txt && getent hosts example.com >/dev/null" }),
  });
  if (result.code !== 0 || !String(result.stdout).includes("kiln-firecracker-ok")) {
    throw new Error(`Unexpected exec result: ${JSON.stringify(result)}`);
  }
  console.log("Firecracker manager smoke completed.");
} finally {
  await request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}`, { method: "DELETE" }).catch(() => {});
}
