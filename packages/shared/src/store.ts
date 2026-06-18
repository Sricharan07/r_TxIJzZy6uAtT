import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Eval,
  EvalConfig,
  OzAgentState,
  OzArtifact,
  OzEvent,
  OzJob,
  OzMode,
  RunResult,
  ServiceHeartbeat,
  ServiceType,
  User,
} from "./types.js";
import { MOCK_EVAL, MOCK_RUN, MOCK_RUN_ERROR, MOCK_RUN_FIXED, MOCK_USER } from "./mock.js";
import { PostgresKilnStore } from "./postgres-store.js";

interface StoreState {
  users: User[];
  sessions: AuthSession[];
  evals: Eval[];
  runs: RunResult[];
  ozJobs: OzJob[];
  ozEvents: OzEvent[];
  ozArtifacts: OzArtifact[];
  serviceHeartbeats: ServiceHeartbeat[];
  ozFeedbackEvents: Array<{
    id: string;
    jobId: string;
    eventType: string;
    before?: unknown;
    after?: unknown;
    createdAt: string;
  }>;
}

interface AuthSession {
  tokenHash: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export interface EvalSummary {
  id: string;
  title: string;
  createdAt: string;
  runCount: number;
}

export interface KilnStore {
  getOrCreateDevUser(): Promise<User>;
  upsertUser(user: User): Promise<User>;
  getUser(id: string): Promise<User | null>;
  createSession(tokenHash: string, userId: string, expiresAt: string): Promise<void>;
  getSessionUserId(tokenHash: string): Promise<string | null>;
  deleteSession(tokenHash: string): Promise<void>;
  createEval(userId: string, config: EvalConfig): Promise<Eval>;
  getEval(idOrShareToken: string): Promise<Eval | null>;
  listEvals(userId: string): Promise<EvalSummary[]>;
  createRun(evalRecord: Eval): Promise<RunResult>;
  getRun(id: string): Promise<RunResult | null>;
  listRuns(evalId: string): Promise<RunResult[]>;
  saveRun(run: RunResult): Promise<void>;
  stopRuns(runIds: string[], reason: string): Promise<void>;
  deleteRuns(runIds: string[], evalId?: string): Promise<void>;
  upsertServiceHeartbeat(heartbeat: ServiceHeartbeat): Promise<void>;
  listServiceHeartbeats(serviceType?: ServiceType): Promise<ServiceHeartbeat[]>;
  createOzJob(userId: string, inputUrl: string, mode: OzMode, state: OzAgentState): Promise<OzJob>;
  getOzJob(id: string): Promise<OzJob | null>;
  listOzJobs(userId: string): Promise<OzJob[]>;
  saveOzJob(job: OzJob): Promise<void>;
  deleteOzJob(jobId: string): Promise<void>;
  appendOzEvent(event: OzEvent): Promise<OzEvent>;
  listOzEvents(jobId: string, options?: { afterId?: string; limit?: number }): Promise<OzEvent[]>;
  createOzArtifact(jobId: string, type: string, name: string, data?: unknown, blobUrl?: string): Promise<OzArtifact>;
  listOzArtifacts(jobId: string): Promise<OzArtifact[]>;
  appendOzFeedback(jobId: string, eventType: string, before?: unknown, after?: unknown): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function titleFromTask(task: string): string {
  const first = task.split("\n", 1)[0]?.trim() || "Untitled eval";
  return first.length > 80 ? first.slice(0, 77) + "..." : first;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function defaultState(): StoreState {
  return {
    users: [MOCK_USER],
    sessions: [],
    evals: [MOCK_EVAL],
    runs: [MOCK_RUN, MOCK_RUN_FIXED, MOCK_RUN_ERROR],
    ozJobs: [],
    ozEvents: [],
    ozArtifacts: [],
    serviceHeartbeats: [],
    ozFeedbackEvents: [],
  };
}

function dataFilePath(): string {
  return process.env.KILN_DATA_FILE ?? join(process.cwd(), ".kiln", "data.json");
}

export class JsonKilnStore implements KilnStore {
  private state: StoreState | null = null;

  constructor(private readonly filePath: string = dataFilePath()) {}

  async getOrCreateDevUser(): Promise<User> {
    const state = await this.load();
    const existing = state.users.find((u) => u.id === MOCK_USER.id);
    if (existing) return existing;
    state.users.push(MOCK_USER);
    await this.persist(state);
    return MOCK_USER;
  }

  async upsertUser(user: User): Promise<User> {
    const state = await this.load();
    const idx = state.users.findIndex((u) => u.id === user.id);
    if (idx >= 0) {
      state.users[idx] = user;
    } else {
      state.users.push(user);
    }
    await this.persist(state);
    return user;
  }

  async getUser(id: string): Promise<User | null> {
    const state = await this.load();
    return state.users.find((u) => u.id === id) ?? null;
  }

  async createSession(tokenHash: string, userId: string, expiresAt: string): Promise<void> {
    const state = await this.load();
    state.sessions = [
      ...this.liveSessions(state.sessions).filter((session) => session.tokenHash !== tokenHash),
      { tokenHash, userId, expiresAt, createdAt: nowIso() },
    ];
    await this.persist(state);
  }

  async getSessionUserId(tokenHash: string): Promise<string | null> {
    const state = await this.load();
    const liveSessions = this.liveSessions(state.sessions);
    if (liveSessions.length !== state.sessions.length) {
      state.sessions = liveSessions;
      await this.persist(state);
    }
    const session = liveSessions.find((item) => item.tokenHash === tokenHash);
    if (!session) return null;
    return state.users.some((user) => user.id === session.userId) ? session.userId : null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    const state = await this.load();
    const next = state.sessions.filter((session) => session.tokenHash !== tokenHash);
    if (next.length === state.sessions.length) return;
    state.sessions = next;
    await this.persist(state);
  }

  async createEval(userId: string, config: EvalConfig): Promise<Eval> {
    const state = await this.load();
    const evalRecord: Eval = {
      id: newId("eval"),
      userId,
      config,
      createdAt: nowIso(),
      shareToken: newId("cfg"),
    };
    state.evals.push(evalRecord);
    await this.persist(state);
    return evalRecord;
  }

  async getEval(idOrShareToken: string): Promise<Eval | null> {
    const state = await this.load();
    return state.evals.find((e) => e.id === idOrShareToken || e.shareToken === idOrShareToken) ?? null;
  }

  async listEvals(userId: string): Promise<EvalSummary[]> {
    const state = await this.load();
    return state.evals
      .filter((e) => e.userId === userId)
      .map((e) => {
        const runs = state.runs.filter((r) => r.evalId === e.id);
        const latest = runs.length > 0 ? runs[runs.length - 1] : undefined;
        return {
          id: e.id,
          title: latest?.evalTitle ?? titleFromTask(e.config.task),
          createdAt: e.createdAt,
          runCount: runs.length,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createRun(evalRecord: Eval): Promise<RunResult> {
    const state = await this.load();
    const run: RunResult = {
      id: newId("run"),
      evalId: evalRecord.id,
      evalTitle: titleFromTask(evalRecord.config.task),
      task: evalRecord.config.task,
      agentType: evalRecord.config.metadata.agentType,
      status: "pending",
      errorType: null,
      startedAt: nowIso(),
      finishedAt: null,
      durationSec: 0,
      totalSteps: 0,
      tokens: 0,
      events: [],
      verdicts: [],
    };
    state.runs.push(run);
    await this.persist(state);
    return run;
  }

  async getRun(id: string): Promise<RunResult | null> {
    const state = await this.load();
    return state.runs.find((r) => r.id === id) ?? null;
  }

  async listRuns(evalId: string): Promise<RunResult[]> {
    const state = await this.load();
    return state.runs
      .filter((r) => r.evalId === evalId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async saveRun(run: RunResult): Promise<void> {
    const state = await this.load();
    const idx = state.runs.findIndex((r) => r.id === run.id);
    if (idx >= 0) {
      state.runs[idx] = run;
    } else {
      state.runs.push(run);
    }
    await this.persist(state);
  }

  async stopRuns(runIds: string[], reason: string): Promise<void> {
    if (runIds.length === 0) return;
    const state = await this.load();
    const now = nowIso();
    for (const run of state.runs) {
      if (!runIds.includes(run.id) || (run.status !== "pending" && run.status !== "running")) continue;
      run.status = "canceled";
      run.errorType = null;
      run.finishedAt = run.finishedAt ?? now;
      run.events = [
        ...run.events,
        { t: run.durationSec ?? 0, kind: "fail", text: "Run stopped", annotation: reason },
      ];
    }
    await this.persist(state);
  }

  async upsertServiceHeartbeat(heartbeat: ServiceHeartbeat): Promise<void> {
    const state = await this.load();
    const idx = state.serviceHeartbeats.findIndex((item) => item.serviceId === heartbeat.serviceId);
    if (idx >= 0) state.serviceHeartbeats[idx] = heartbeat;
    else state.serviceHeartbeats.push(heartbeat);
    await this.persist(state);
  }

  async listServiceHeartbeats(serviceType?: ServiceType): Promise<ServiceHeartbeat[]> {
    const state = await this.load();
    return state.serviceHeartbeats
      .filter((heartbeat) => !serviceType || heartbeat.serviceType === serviceType)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  async deleteRuns(runIds: string[], evalId?: string): Promise<void> {
    if (runIds.length === 0 && !evalId) return;
    const state = await this.load();
    const ids = new Set(runIds);
    state.runs = state.runs.filter((run) => !ids.has(run.id));
    if (evalId && !state.runs.some((run) => run.evalId === evalId)) {
      state.evals = state.evals.filter((evalRecord) => evalRecord.id !== evalId);
    }
    await this.persist(state);
  }

  private async load(): Promise<StoreState> {
    if (this.state) return this.state;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreState>;
      this.state = {
        users: parsed.users ?? [MOCK_USER],
        sessions: parsed.sessions ?? [],
        evals: parsed.evals ?? [MOCK_EVAL],
        runs: parsed.runs ?? [MOCK_RUN, MOCK_RUN_FIXED, MOCK_RUN_ERROR],
        ozJobs: parsed.ozJobs ?? [],
        ozEvents: parsed.ozEvents ?? [],
        ozArtifacts: parsed.ozArtifacts ?? [],
        serviceHeartbeats: parsed.serviceHeartbeats ?? [],
        ozFeedbackEvents: parsed.ozFeedbackEvents ?? [],
      };
    } catch {
      this.state = defaultState();
      await this.persist(this.state);
    }
    return this.state;
  }

  private async persist(state: StoreState): Promise<void> {
    this.state = state;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, this.filePath);
  }

  private liveSessions(sessions: AuthSession[]): AuthSession[] {
    const now = Date.now();
    return sessions.filter((session) => Date.parse(session.expiresAt) > now);
  }

  async createOzJob(userId: string, inputUrl: string, mode: OzMode, state: OzAgentState): Promise<OzJob> {
    const current = await this.load();
    const job: OzJob = {
      id: state.jobId,
      userId,
      inputUrl,
      mode,
      status: "created",
      state,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    current.ozJobs.push(job);
    await this.persist(current);
    return job;
  }

  async getOzJob(id: string): Promise<OzJob | null> {
    const current = await this.load();
    return current.ozJobs.find((job) => job.id === id) ?? null;
  }

  async listOzJobs(userId: string): Promise<OzJob[]> {
    const current = await this.load();
    return current.ozJobs
      .filter((job) => job.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveOzJob(job: OzJob): Promise<void> {
    const current = await this.load();
    const idx = current.ozJobs.findIndex((item) => item.id === job.id);
    const next: OzJob = { ...job, updatedAt: nowIso() };
    if (idx >= 0) current.ozJobs[idx] = next;
    else current.ozJobs.push(next);
    await this.persist(current);
  }

  async deleteOzJob(jobId: string): Promise<void> {
    const current = await this.load();
    current.ozJobs = current.ozJobs.filter((job) => job.id !== jobId);
    current.ozEvents = current.ozEvents.filter((event) => event.jobId !== jobId);
    current.ozArtifacts = current.ozArtifacts.filter((artifact) => artifact.jobId !== jobId);
    current.ozFeedbackEvents = current.ozFeedbackEvents.filter((event) => event.jobId !== jobId);
    await this.persist(current);
  }

  async appendOzEvent(event: OzEvent): Promise<OzEvent> {
    const current = await this.load();
    if (event.dedupeKey) {
      const existing = current.ozEvents.find((item) => item.jobId === event.jobId && item.dedupeKey === event.dedupeKey);
      if (existing) return existing;
    }
    const saved: OzEvent = {
      ...event,
      id: event.id ?? newId("ozevt"),
      createdAt: event.createdAt ?? nowIso(),
    };
    current.ozEvents.push(saved);
    const job = current.ozJobs.find((item) => item.id === event.jobId);
    if (job) job.updatedAt = nowIso();
    await this.persist(current);
    return saved;
  }

  async listOzEvents(jobId: string, options: { afterId?: string; limit?: number } = {}): Promise<OzEvent[]> {
    const current = await this.load();
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 250), 1), 1_000);
    const jobEvents = current.ozEvents.filter((event) => event.jobId === jobId);
    if (options.afterId) {
      const afterIndex = jobEvents.findIndex((event) => event.id === options.afterId);
      const start = afterIndex >= 0 ? afterIndex + 1 : 0;
      return jobEvents.slice(start, start + limit);
    }
    return jobEvents.slice(Math.max(jobEvents.length - limit, 0));
  }

  async createOzArtifact(jobId: string, type: string, name: string, data?: unknown, blobUrl?: string): Promise<OzArtifact> {
    const current = await this.load();
    const artifact: OzArtifact = {
      id: newId("ozart"),
      jobId,
      type,
      name,
      data,
      blobUrl,
      createdAt: nowIso(),
    };
    current.ozArtifacts.push(artifact);
    await this.persist(current);
    return artifact;
  }

  async listOzArtifacts(jobId: string): Promise<OzArtifact[]> {
    const current = await this.load();
    return current.ozArtifacts
      .filter((artifact) => artifact.jobId === jobId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async appendOzFeedback(jobId: string, eventType: string, before?: unknown, after?: unknown): Promise<void> {
    const current = await this.load();
    current.ozFeedbackEvents.push({
      id: newId("ozfb"),
      jobId,
      eventType,
      before,
      after,
      createdAt: nowIso(),
    });
    await this.persist(current);
  }
}

const globalStore = globalThis as typeof globalThis & {
  __kilnStore?: KilnStore;
  __kilnStoreKey?: string;
};

export function getStore(): KilnStore {
  const key = process.env.DATABASE_URL ? `postgres:${process.env.DATABASE_URL}` : "json";
  if (!globalStore.__kilnStore || globalStore.__kilnStoreKey !== key) {
    globalStore.__kilnStore = process.env.DATABASE_URL
      ? new PostgresKilnStore(process.env.DATABASE_URL)
      : new JsonKilnStore();
    globalStore.__kilnStoreKey = key;
  }
  return globalStore.__kilnStore;
}
