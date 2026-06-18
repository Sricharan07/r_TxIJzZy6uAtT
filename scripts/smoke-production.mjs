import { createHash, randomBytes } from "node:crypto";
import { getStore } from "../packages/shared/dist/store.js";
import { loadDotEnv } from "./lib/env.mjs";

loadDotEnv();

const appUrl = (process.env.KILN_SMOKE_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
let cookie = process.env.KILN_SMOKE_SESSION_COOKIE ?? "";
const sessionCookieName = "kiln_session";
const timeoutMs = Number(process.env.KILN_SMOKE_TIMEOUT_MS ?? 180_000);
const pollMs = Number(process.env.KILN_SMOKE_POLL_MS ?? 3_000);
let generatedSessionHash = "";

if (!appUrl) {
  console.error("KILN_SMOKE_APP_URL or NEXT_PUBLIC_APP_URL is required.");
  process.exit(1);
}

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function ensureSmokeCookie() {
  if (cookie) return;
  const store = getStore();
  const user = await store.upsertUser({
    id: "smoke_user",
    githubId: -1,
    login: "kiln-smoke",
    avatarUrl: "",
    createdAt: new Date().toISOString(),
  });
  const token = randomBytes(32).toString("base64url");
  generatedSessionHash = hashSessionToken(token);
  await store.createSession(generatedSessionHash, user.id, new Date(Date.now() + 15 * 60_000).toISOString());
  cookie = `${sessionCookieName}=${token}`;
  console.log("Created local smoke session.");
}

async function request(path, init = {}) {
  const response = await fetch(`${appUrl}${path}`, {
    ...init,
    headers: {
      cookie,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Keep HTML/text bodies as-is for diagnostics.
  }
  if (!response.ok) {
    const detail = typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body);
    throw new Error(`${init.method ?? "GET"} ${path} failed with ${response.status}: ${detail}`);
  }
  return body;
}

const evalConfig = {
  task: "Create src/kiln-smoke.txt containing the text kiln-smoke-ok.",
  language: "node",
  context: [
    {
      type: "paste",
      label: "Smoke test instruction",
      content: "This smoke eval verifies auth, eval creation, queueing, runner execution, persistence, and report rendering.",
    },
  ],
  assertions: [
    {
      type: "file",
      name: "smoke file exists",
      config: { path: "src/kiln-smoke.txt", contains: "kiln-smoke-ok" },
    },
  ],
  metadata: {
    agentType: "claude-code",
    timeoutSec: 120,
    requestedRuns: 1,
  },
};

try {
  await ensureSmokeCookie();

  console.log(`Creating smoke eval against ${appUrl}`);
  const created = await request("/api/evals", {
    method: "POST",
    body: JSON.stringify(evalConfig),
  });

  const evalId = created.evalId;
  const runId = created.runId;
  if (!evalId || !runId) throw new Error(`Create response missing evalId/runId: ${JSON.stringify(created)}`);

  const deadline = Date.now() + timeoutMs;
  let finalRun;
  while (Date.now() < deadline) {
    const detail = await request(`/api/evals/${evalId}`);
    finalRun = detail.runs?.find((run) => run.id === runId);
    if (!finalRun) throw new Error(`Run ${runId} was not returned by /api/evals/${evalId}.`);
    console.log(`Run ${runId}: ${finalRun.status}`);
    if (finalRun.status === "completed" || finalRun.status === "errored") break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  if (!finalRun || (finalRun.status !== "completed" && finalRun.status !== "errored")) {
    throw new Error(`Run ${runId} did not finish within ${timeoutMs}ms.`);
  }
  if (finalRun.status !== "completed") {
    throw new Error(`Run ${runId} finished with ${finalRun.status}/${finalRun.errorType ?? "unknown"}.`);
  }

  const report = await fetch(`${appUrl}/reports/${runId}`, { headers: { cookie } });
  if (!report.ok) throw new Error(`Report ${runId} failed with ${report.status}.`);

  console.log(`Production smoke completed: ${appUrl}/reports/${runId}`);
} finally {
  if (generatedSessionHash) {
    await getStore().deleteSession(generatedSessionHash);
  }
}
