import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Eval, EvalConfig, RunResult, User } from "./types.js";
import { MOCK_EVAL, MOCK_RUN, MOCK_RUN_ERROR, MOCK_RUN_FIXED, MOCK_USER } from "./mock.js";
import { PostgresKilnStore } from "./postgres-store.js";

interface StoreState {
  users: User[];
  evals: Eval[];
  runs: RunResult[];
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
  createEval(userId: string, config: EvalConfig): Promise<Eval>;
  getEval(idOrShareToken: string): Promise<Eval | null>;
  listEvals(userId: string): Promise<EvalSummary[]>;
  createRun(evalRecord: Eval): Promise<RunResult>;
  getRun(id: string): Promise<RunResult | null>;
  listRuns(evalId: string): Promise<RunResult[]>;
  saveRun(run: RunResult): Promise<void>;
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
    evals: [MOCK_EVAL],
    runs: [MOCK_RUN, MOCK_RUN_FIXED, MOCK_RUN_ERROR],
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

  private async load(): Promise<StoreState> {
    if (this.state) return this.state;
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = JSON.parse(raw) as StoreState;
    } catch {
      this.state = defaultState();
      await this.persist(this.state);
    }
    return this.state;
  }

  private async persist(state: StoreState): Promise<void> {
    this.state = state;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, this.filePath);
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
