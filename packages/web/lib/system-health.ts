import { getStore } from "@kiln/shared/store";
import type { ServiceHeartbeat } from "@kiln/shared";

export interface HealthCheck {
  name: string;
  ok: boolean;
  message: string;
  checkedAt: string;
}

export interface RunInfrastructureHealth {
  ok: boolean;
  checks: HealthCheck[];
  blockers: string[];
}

const RUNNER_HEARTBEAT_TTL_MS = Number(process.env.KILN_RUNNER_HEARTBEAT_TTL_MS ?? 30_000);

function nowIso(): string {
  return new Date().toISOString();
}

function redisConnection() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

function liveHeartbeats(heartbeats: ServiceHeartbeat[]): ServiceHeartbeat[] {
  const now = Date.now();
  return heartbeats.filter((heartbeat) => now - Date.parse(heartbeat.lastSeenAt) <= RUNNER_HEARTBEAT_TTL_MS);
}

async function checkQueue(): Promise<HealthCheck> {
  const checkedAt = nowIso();
  const mode = process.env.KILN_QUEUE_MODE ?? (process.env.NODE_ENV === "production" ? "redis" : "local");
  if (mode === "local") {
    return { name: "queue", ok: true, message: "Local in-process runner mode is enabled.", checkedAt };
  }
  if (mode !== "redis") {
    return { name: "queue", ok: false, message: `Unknown KILN_QUEUE_MODE "${mode}".`, checkedAt };
  }
  const connection = redisConnection();
  if (!connection) {
    return { name: "queue", ok: false, message: "REDIS_URL is required when KILN_QUEUE_MODE=redis.", checkedAt };
  }
  try {
    const bullmqSpecifier = "bullmq";
    const { Queue } = (await import(bullmqSpecifier)) as {
      Queue: new (
        name: string,
        options: Record<string, unknown>,
      ) => {
        getJobCounts(...types: string[]): Promise<Record<string, number>>;
        close(): Promise<void>;
      };
    };
    const queue = new Queue("kiln-runs", { connection });
    try {
      const counts = await queue.getJobCounts("waiting", "active", "delayed");
      return {
        name: "queue",
        ok: true,
        message: `Redis queue reachable: ${counts.waiting ?? 0} waiting, ${counts.active ?? 0} active.`,
        checkedAt,
      };
    } finally {
      await queue.close();
    }
  } catch (err) {
    return {
      name: "queue",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      checkedAt,
    };
  }
}

async function checkRunnerHeartbeat(): Promise<HealthCheck> {
  const checkedAt = nowIso();
  const mode = process.env.KILN_QUEUE_MODE ?? (process.env.NODE_ENV === "production" ? "redis" : "local");
  if (mode === "local") {
    return { name: "runner", ok: true, message: "Local in-process runner mode is enabled.", checkedAt };
  }
  const heartbeats = await getStore().listServiceHeartbeats("runner");
  const live = liveHeartbeats(heartbeats);
  if (live.length === 0) {
    return { name: "runner", ok: false, message: "No live runner heartbeat is available.", checkedAt };
  }
  const runner = live[0]!;
  return {
    name: "runner",
    ok: true,
    message: `${live.length} runner${live.length === 1 ? "" : "s"} online. Latest: ${runner.serviceId}.`,
    checkedAt,
  };
}

async function checkFirecracker(): Promise<HealthCheck> {
  const checkedAt = nowIso();
  const sandboxMode = process.env.KILN_SANDBOX_MODE ?? (process.env.NODE_ENV === "production" ? "firecracker" : "local");
  if (sandboxMode !== "firecracker") {
    return { name: "firecracker", ok: true, message: `Sandbox mode is ${sandboxMode}.`, checkedAt };
  }
  const managerUrl = process.env.KILN_FIRECRACKER_MANAGER_URL;
  if (!managerUrl) {
    return { name: "firecracker", ok: false, message: "KILN_FIRECRACKER_MANAGER_URL is required.", checkedAt };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(new URL("/v1/health", managerUrl).toString(), {
      headers: process.env.KILN_FIRECRACKER_MANAGER_TOKEN
        ? { Authorization: `Bearer ${process.env.KILN_FIRECRACKER_MANAGER_TOKEN}` }
        : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      return { name: "firecracker", ok: false, message: `Firecracker manager returned HTTP ${response.status}.`, checkedAt };
    }
    const body = await response.json().catch(() => undefined) as
      | { diagnostics?: { activeSandboxes?: number; leakedTapNames?: string[] } }
      | undefined;
    const leakedTapNames = body?.diagnostics?.leakedTapNames ?? [];
    if (leakedTapNames.length > 0) {
      return {
        name: "firecracker",
        ok: false,
        message: `Firecracker manager has leaked tap devices: ${leakedTapNames.join(", ")}.`,
        checkedAt,
      };
    }
    const active = body?.diagnostics?.activeSandboxes;
    return {
      name: "firecracker",
      ok: true,
      message: `Firecracker manager is reachable${typeof active === "number" ? `; ${active} active sandbox${active === 1 ? "" : "es"}.` : "."}`,
      checkedAt,
    };
  } catch (err) {
    return {
      name: "firecracker",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      checkedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getRunInfrastructureHealth(): Promise<RunInfrastructureHealth> {
  const checks = await Promise.all([checkQueue(), checkRunnerHeartbeat(), checkFirecracker()]);
  const blockers = checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.message}`);
  return { ok: blockers.length === 0, checks, blockers };
}
