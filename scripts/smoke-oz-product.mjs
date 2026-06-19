import { createHash, randomBytes } from "node:crypto";
import { getStore } from "../packages/shared/dist/store.js";
import { loadDotEnv } from "./lib/env.mjs";

loadDotEnv();

const appUrl = (process.env.KILN_SMOKE_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
const productUrl = process.env.KILN_SMOKE_PRODUCT_URL ?? "https://moss.dev/docs";
const timeoutMs = Number(process.env.KILN_SMOKE_TIMEOUT_MS ?? 240_000);
const pollMs = Number(process.env.KILN_SMOKE_POLL_MS ?? 3_000);
let cookie = process.env.KILN_SMOKE_SESSION_COOKIE ?? "";
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
    id: "oz_smoke_user",
    githubId: -2,
    login: "kiln-oz-smoke",
    avatarUrl: "",
    createdAt: new Date().toISOString(),
  });
  const token = randomBytes(32).toString("base64url");
  generatedSessionHash = hashSessionToken(token);
  await store.createSession(generatedSessionHash, user.id, new Date(Date.now() + 30 * 60_000).toISOString());
  cookie = `kiln_session=${token}`;
  console.log("Created Oz smoke session.");
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
    // Keep text/HTML diagnostics intact.
  }
  if (!response.ok) {
    const detail = typeof body === "string" ? body.slice(0, 700) : JSON.stringify(body);
    throw new Error(`${init.method ?? "GET"} ${path} failed with ${response.status}: ${detail}`);
  }
  return body;
}

function terminalEnough(job) {
  return ["awaiting_approval", "blocked", "failed", "complete", "stopped"].includes(job.status);
}

try {
  await ensureSmokeCookie();
  console.log(`Creating Oz product smoke job for ${productUrl}`);
  const created = await request("/api/oz/jobs", {
    method: "POST",
    body: JSON.stringify({
      productUrl,
      mode: "copilot",
      preferredLanguage: "node",
      agentTargets: ["claude-code"],
      userGoal: "Validate docs, auth, SDK/package consistency, and first integration workflows.",
    }),
  });

  const jobId = created.job?.id;
  if (!jobId) throw new Error(`Create response missing job id: ${JSON.stringify(created)}`);

  const deadline = Date.now() + timeoutMs;
  let latest = created;
  while (Date.now() < deadline) {
    latest = await request(`/api/oz/jobs/${jobId}`);
    const job = latest.job;
    if (!job) throw new Error(`Job ${jobId} was not returned.`);
    console.log(`Oz job ${jobId}: ${job.status}`);
    if (terminalEnough(job)) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  const job = latest.job;
  if (!job || !terminalEnough(job)) {
    throw new Error(`Oz job ${jobId} did not reach a reviewable state within ${timeoutMs}ms.`);
  }
  if (job.status === "failed") {
    throw new Error(`Oz job ${jobId} failed: ${job.state?.error ?? "unknown error"}`);
  }

  const research = job.state?.research;
  const suite = job.state?.suiteDraft;
  console.log(JSON.stringify({
    jobId,
    status: job.status,
    productName: job.state?.productProfile?.productName,
    checkedSources: research?.checkedSources?.length ?? 0,
    claims: research?.claims?.length ?? 0,
    conflicts: (research?.conflicts ?? []).map((conflict) => ({
      id: conflict.id,
      title: conflict.title,
      severity: conflict.severity,
      status: conflict.status,
    })),
    scenarios: (suite?.scenarios ?? []).map((scenario) => scenario.id),
    missingSecrets: job.state?.verification?.missingSecrets ?? [],
  }, null, 2));

  if (!research) throw new Error("Oz product smoke did not produce a research report.");
  if (!suite?.scenarios?.length) throw new Error("Oz product smoke did not produce a suite.");

  console.log(`Oz product smoke completed: ${appUrl}/oz?job=${jobId}`);
} finally {
  if (generatedSessionHash) {
    await getStore().deleteSession(generatedSessionHash);
  }
}
