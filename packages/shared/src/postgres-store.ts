import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import {
  SCHEMA_SQL,
  type AuthSessionRow,
  type EvalRow,
  type OzArtifactRow,
  type OzEventRow,
  type OzJobRow,
  type ProductSecretRow,
  type RunRow,
  type ServiceHeartbeatRow,
  type UserRow,
  type VerdictRow,
} from "./db/schema.js";
import { getBlobStore, type BlobStore } from "./s3.js";
import type {
  Eval,
  EvalConfig,
  GradeReport,
  GraderEvidence,
  OzAgentState,
  OzArtifact,
  OzEvent,
  OzEventKind,
  OzJob,
  OzJobStatus,
  OzMode,
  ProductSecretScopeType,
  ProductSecretSummary,
  RunResult,
  ServiceHeartbeat,
  ServiceType,
  User,
  Verdict,
} from "./types.js";
import type { EvalSummary, KilnStore } from "./store.js";
import { MOCK_USER } from "./mock.js";
import { decryptSecretValue, encryptSecretValue } from "./secrets.js";

interface RunWithConfigRow extends RunRow {
  config: EvalConfig;
}

function titleFromTask(task: string): string {
  const first = task.split("\n", 1)[0]?.trim() || "Untitled eval";
  return first.length > 80 ? first.slice(0, 77) + "..." : first;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    githubId: Number(row.github_id),
    login: row.login,
    avatarUrl: row.avatar_url ?? "",
    createdAt: row.created_at,
  };
}

function toEval(row: EvalRow): Eval {
  return {
    id: row.id,
    userId: row.user_id,
    config: row.config as EvalConfig,
    createdAt: row.created_at,
    shareToken: row.share_token,
  };
}

function toOzJob(row: OzJobRow): OzJob {
  return {
    id: row.id,
    userId: row.user_id,
    inputUrl: row.input_url,
    mode: row.mode as OzMode,
    status: row.status as OzJobStatus,
    state: row.state as OzAgentState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOzEvent(row: OzEventRow): OzEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind as OzEventKind,
    phase: row.phase as OzJobStatus,
    message: row.message,
    dedupeKey: row.dedupe_key ?? undefined,
    payload: row.payload ? (row.payload as Record<string, unknown>) : undefined,
    createdAt: row.created_at,
  };
}

function toOzArtifact(row: OzArtifactRow): OzArtifact {
  return {
    id: row.id,
    jobId: row.job_id,
    type: row.type,
    name: row.name,
    data: row.data ?? undefined,
    blobUrl: row.blob_url ?? undefined,
    createdAt: row.created_at,
  };
}

function toServiceHeartbeat(row: ServiceHeartbeatRow): ServiceHeartbeat {
  return {
    serviceId: row.service_id,
    serviceType: row.service_type as ServiceHeartbeat["serviceType"],
    status: "online",
    lastSeenAt: row.last_seen_at,
    version: row.version ?? undefined,
    queueName: row.queue_name ?? undefined,
    concurrency: row.concurrency ?? undefined,
    sandboxMode: row.sandbox_mode ?? undefined,
    metadata: row.metadata ? (row.metadata as Record<string, unknown>) : undefined,
  };
}

function githubIdFor(user: User): number {
  if (user.githubId !== undefined) return user.githubId;
  const fromLegacyId = /^gh_(\d+)$/.exec(user.id)?.[1];
  if (fromLegacyId) return Number(fromLegacyId);
  throw new Error(`GitHub user "${user.login}" is missing githubId.`);
}

function toVerdict(row: VerdictRow): Verdict {
  return {
    assertionIndex: row.assertion_index,
    type: row.type as Verdict["type"],
    name: row.name,
    passed: row.passed,
    output: row.output ?? undefined,
    hint: row.hint ?? undefined,
    evidence: row.evidence ? (row.evidence as GraderEvidence[]) : undefined,
  };
}

export class PostgresKilnStore implements KilnStore {
  private readonly schemaReady: Promise<unknown> | null;

  constructor(
    connectionString: string,
    private readonly blobs: BlobStore = getBlobStore(),
    private readonly pool: Pool = new Pool({ connectionString }),
    autoMigrate = process.env.KILN_DB_AUTO_MIGRATE === "1",
  ) {
    this.schemaReady = autoMigrate ? this.pool.query(SCHEMA_SQL) : null;
  }

  async getOrCreateDevUser(): Promise<User> {
    const result = await this.query<UserRow>(
      `INSERT INTO users (github_id, login, avatar_url)
       VALUES (0, $1, $2)
       ON CONFLICT (github_id) DO UPDATE
       SET login = EXCLUDED.login, avatar_url = EXCLUDED.avatar_url
       RETURNING *`,
      [MOCK_USER.login, MOCK_USER.avatarUrl],
    );
    return toUser(result.rows[0]!);
  }

  async upsertUser(user: User): Promise<User> {
    const result = await this.query<UserRow>(
      `INSERT INTO users (github_id, login, avatar_url)
       VALUES ($1, $2, $3)
       ON CONFLICT (github_id) DO UPDATE
       SET login = EXCLUDED.login, avatar_url = EXCLUDED.avatar_url
       RETURNING *`,
      [githubIdFor(user), user.login, user.avatarUrl],
    );
    return toUser(result.rows[0]!);
  }

  async getUser(id: string): Promise<User | null> {
    const result = await this.query<UserRow>("SELECT * FROM users WHERE id::text = $1", [id]);
    return result.rows[0] ? toUser(result.rows[0]) : null;
  }

  async createSession(tokenHash: string, userId: string, expiresAt: string): Promise<void> {
    await this.query(
      `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (token_hash) DO UPDATE
       SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
      [tokenHash, userId, expiresAt],
    );
  }

  async getSessionUserId(tokenHash: string): Promise<string | null> {
    await this.query("DELETE FROM auth_sessions WHERE expires_at <= now()");
    const result = await this.query<AuthSessionRow>(
      "SELECT * FROM auth_sessions WHERE token_hash = $1 AND expires_at > now()",
      [tokenHash],
    );
    return result.rows[0]?.user_id ?? null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.query("DELETE FROM auth_sessions WHERE token_hash = $1", [tokenHash]);
  }

  async upsertProductSecrets(input: {
    userId: string;
    scopeType: ProductSecretScopeType;
    scopeId: string;
    values: Record<string, string>;
  }): Promise<ProductSecretSummary[]> {
    const entries = Object.entries(input.values).filter(([, value]) => value.length > 0);
    if (entries.length === 0) return this.listProductSecretSummaries(input.userId, input.scopeType, input.scopeId);
    const client = await this.pool.connect();
    try {
      await this.schemaReady;
      await client.query("BEGIN");
      for (const [name, value] of entries) {
        await client.query(
          `INSERT INTO product_secrets (user_id, scope_type, scope_id, name, value_cipher)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, scope_type, scope_id, name) DO UPDATE
           SET value_cipher = EXCLUDED.value_cipher, updated_at = now()`,
          [input.userId, input.scopeType, input.scopeId, name, encryptSecretValue(value)],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return this.listProductSecretSummaries(input.userId, input.scopeType, input.scopeId);
  }

  async deleteProductSecrets(input: {
    userId: string;
    scopeType: ProductSecretScopeType;
    scopeId: string;
    names?: string[];
  }): Promise<void> {
    if (input.names && input.names.length === 0) return;
    await this.query(
      input.names
        ? `DELETE FROM product_secrets
           WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3 AND name = ANY($4)`
        : `DELETE FROM product_secrets
           WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3`,
      input.names ? [input.userId, input.scopeType, input.scopeId, input.names] : [input.userId, input.scopeType, input.scopeId],
    );
  }

  async listProductSecretSummaries(userId: string, scopeType: ProductSecretScopeType, scopeId: string): Promise<ProductSecretSummary[]> {
    const result = await this.query<ProductSecretRow>(
      `SELECT * FROM product_secrets
       WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3
       ORDER BY name ASC`,
      [userId, scopeType, scopeId],
    );
    return result.rows.map((row) => ({
      scopeType: row.scope_type as ProductSecretScopeType,
      scopeId: row.scope_id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getProductSecretValues(userId: string, scopeType: ProductSecretScopeType, scopeId: string): Promise<Record<string, string>> {
    const result = await this.query<ProductSecretRow>(
      `SELECT * FROM product_secrets
       WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3
       ORDER BY name ASC`,
      [userId, scopeType, scopeId],
    );
    return Object.fromEntries(result.rows.map((row) => [row.name, decryptSecretValue(row.value_cipher)]));
  }

  async createEval(userId: string, config: EvalConfig): Promise<Eval> {
    const result = await this.query<EvalRow>(
      `INSERT INTO evals (user_id, config, share_token)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, JSON.stringify(config), `cfg_${randomUUID()}`],
    );
    return toEval(result.rows[0]!);
  }

  async getEval(idOrShareToken: string): Promise<Eval | null> {
    const result = await this.query<EvalRow>(
      "SELECT * FROM evals WHERE id::text = $1 OR share_token = $1",
      [idOrShareToken],
    );
    return result.rows[0] ? toEval(result.rows[0]) : null;
  }

  async listEvals(userId: string): Promise<EvalSummary[]> {
    const result = await this.query<EvalRow & { run_count: string }>(
      `SELECT e.*, count(r.id)::text AS run_count
       FROM evals e
       LEFT JOIN runs r ON r.eval_id = e.id
       WHERE e.user_id = $1
       GROUP BY e.id
       ORDER BY e.created_at DESC`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: titleFromTask((row.config as EvalConfig).task),
      createdAt: row.created_at,
      runCount: Number(row.run_count),
    }));
  }

  async createRun(evalRecord: Eval): Promise<RunResult> {
    const result = await this.query<RunRow>(
      `INSERT INTO runs (eval_id, agent_type, status, started_at)
       VALUES ($1, $2, 'pending', now())
       RETURNING *`,
      [evalRecord.id, evalRecord.config.metadata.agentType],
    );
    return this.toRun(result.rows[0]!, evalRecord.config, [], []);
  }

  async getRun(id: string): Promise<RunResult | null> {
    const result = await this.query<RunWithConfigRow>(
      `SELECT r.*, e.config
       FROM runs r
       JOIN evals e ON e.id = r.eval_id
       WHERE r.id::text = $1`,
      [id],
    );
    return result.rows[0] ? this.hydrateRun(result.rows[0]) : null;
  }

  async listRuns(evalId: string): Promise<RunResult[]> {
    const result = await this.query<RunWithConfigRow>(
      `SELECT r.*, e.config
       FROM runs r
       JOIN evals e ON e.id = r.eval_id
       WHERE r.eval_id = $1
       ORDER BY r.started_at ASC`,
      [evalId],
    );
    return Promise.all(result.rows.map((row) => this.hydrateRun(row)));
  }

  async saveRun(run: RunResult): Promise<void> {
    const traceKey = await this.blobs.putTrace(run.id, run.events);
    const client = await this.pool.connect();
    try {
      await this.schemaReady;
      await client.query("BEGIN");
      await client.query(
        `UPDATE runs
         SET agent_type = $2, status = $3, error_type = $4, started_at = $5,
             finished_at = $6, total_steps = $7, tokens = $8, trace_s3_key = $9,
             grade_report = $10
         WHERE id = $1`,
        [
          run.id,
          run.agentType,
          run.status,
          run.errorType,
          run.startedAt,
          run.finishedAt,
          run.totalSteps,
          run.tokens,
          traceKey,
          run.gradeReport ? JSON.stringify(run.gradeReport) : null,
        ],
      );
      await client.query("DELETE FROM verdicts WHERE run_id = $1", [run.id]);
      for (const verdict of run.verdicts) {
        await client.query(
          `INSERT INTO verdicts (run_id, assertion_index, type, name, passed, output, hint, evidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            run.id,
            verdict.assertionIndex,
            verdict.type,
            verdict.name,
            verdict.passed,
            verdict.output ?? null,
            verdict.hint ?? null,
            verdict.evidence ? JSON.stringify(verdict.evidence) : null,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async stopRuns(runIds: string[], _reason: string): Promise<void> {
    if (runIds.length === 0) return;
    await this.query(
      `UPDATE runs
       SET status = 'canceled',
           error_type = NULL,
           finished_at = COALESCE(finished_at, now()),
           grade_report = NULL
       WHERE id::text = ANY($1) AND status IN ('pending', 'running')`,
      [runIds],
    );
  }

  async deleteRuns(runIds: string[], evalId?: string): Promise<void> {
    if (runIds.length === 0 && !evalId) return;
    const client = await this.pool.connect();
    try {
      await this.schemaReady;
      await client.query("BEGIN");
      if (runIds.length > 0) {
        await client.query("DELETE FROM verdicts WHERE run_id::text = ANY($1)", [runIds]);
        await client.query("DELETE FROM runs WHERE id::text = ANY($1)", [runIds]);
      }
      if (evalId) {
        await client.query("DELETE FROM evals WHERE id::text = $1 AND NOT EXISTS (SELECT 1 FROM runs WHERE eval_id::text = $1)", [evalId]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertServiceHeartbeat(heartbeat: ServiceHeartbeat): Promise<void> {
    await this.query(
      `INSERT INTO service_heartbeats
         (service_id, service_type, status, last_seen_at, version, queue_name, concurrency, sandbox_mode, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (service_id) DO UPDATE
       SET service_type = EXCLUDED.service_type,
           status = EXCLUDED.status,
           last_seen_at = EXCLUDED.last_seen_at,
           version = EXCLUDED.version,
           queue_name = EXCLUDED.queue_name,
           concurrency = EXCLUDED.concurrency,
           sandbox_mode = EXCLUDED.sandbox_mode,
           metadata = EXCLUDED.metadata`,
      [
        heartbeat.serviceId,
        heartbeat.serviceType,
        heartbeat.status,
        heartbeat.lastSeenAt,
        heartbeat.version ?? null,
        heartbeat.queueName ?? null,
        heartbeat.concurrency ?? null,
        heartbeat.sandboxMode ?? null,
        heartbeat.metadata ? JSON.stringify(heartbeat.metadata) : null,
      ],
    );
  }

  async listServiceHeartbeats(serviceType?: ServiceType): Promise<ServiceHeartbeat[]> {
    const result = await this.query<ServiceHeartbeatRow>(
      serviceType
        ? "SELECT * FROM service_heartbeats WHERE service_type = $1 ORDER BY last_seen_at DESC"
        : "SELECT * FROM service_heartbeats ORDER BY last_seen_at DESC",
      serviceType ? [serviceType] : [],
    );
    return result.rows.map(toServiceHeartbeat);
  }

  async createOzJob(userId: string, inputUrl: string, mode: OzMode, state: OzAgentState): Promise<OzJob> {
    const result = await this.query<OzJobRow>(
      `INSERT INTO oz_jobs (id, user_id, input_url, mode, status, state)
       VALUES ($1, $2, $3, $4, 'created', $5)
       RETURNING *`,
      [state.jobId, userId, inputUrl, mode, JSON.stringify(state)],
    );
    return toOzJob(result.rows[0]!);
  }

  async getOzJob(id: string): Promise<OzJob | null> {
    const result = await this.query<OzJobRow>("SELECT * FROM oz_jobs WHERE id::text = $1", [id]);
    return result.rows[0] ? toOzJob(result.rows[0]) : null;
  }

  async listOzJobs(userId: string): Promise<OzJob[]> {
    const result = await this.query<OzJobRow>(
      "SELECT * FROM oz_jobs WHERE user_id = $1 ORDER BY updated_at DESC",
      [userId],
    );
    return result.rows.map(toOzJob);
  }

  async saveOzJob(job: OzJob): Promise<void> {
    await this.query(
      `UPDATE oz_jobs
       SET mode = $2, status = $3, state = $4, updated_at = now()
       WHERE id = $1`,
      [job.id, job.mode, job.status, JSON.stringify(job.state)],
    );
  }

  async deleteOzJob(jobId: string): Promise<void> {
    const job = await this.getOzJob(jobId);
    await this.query("DELETE FROM oz_jobs WHERE id::text = $1", [jobId]);
    if (job) {
      await this.deleteProductSecrets({ userId: job.userId, scopeType: "oz_job", scopeId: jobId });
    }
  }

  async appendOzEvent(event: OzEvent): Promise<OzEvent> {
    const result = await this.query<OzEventRow>(
      `INSERT INTO oz_events (job_id, kind, phase, message, dedupe_key, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (job_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        event.jobId,
        event.kind,
        event.phase,
        event.message,
        event.dedupeKey ?? null,
        event.payload ? JSON.stringify(event.payload) : null,
      ],
    );
    if (result.rows[0]) {
      await this.query("UPDATE oz_jobs SET updated_at = now() WHERE id = $1", [event.jobId]);
      return toOzEvent(result.rows[0]!);
    }
    if (event.dedupeKey) {
      const existing = await this.query<OzEventRow>(
        "SELECT * FROM oz_events WHERE job_id = $1 AND dedupe_key = $2",
        [event.jobId, event.dedupeKey],
      );
      if (existing.rows[0]) return toOzEvent(existing.rows[0]!);
    }
    throw new Error("Could not append Oz event.");
  }

  async listOzEvents(jobId: string, options: { afterId?: string; limit?: number } = {}): Promise<OzEvent[]> {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 250), 1), 1_000);
    if (options.afterId) {
      const result = await this.query<OzEventRow>(
        `WITH cursor AS (
           SELECT event_seq FROM oz_events WHERE job_id = $1 AND id::text = $2
         )
         SELECT * FROM oz_events
         WHERE job_id = $1
           AND event_seq > COALESCE((SELECT event_seq FROM cursor), 0)
         ORDER BY event_seq ASC
         LIMIT $3`,
        [jobId, options.afterId, limit],
      );
      return result.rows.map(toOzEvent);
    }
    const result = await this.query<OzEventRow>(
      `SELECT * FROM (
         SELECT * FROM oz_events WHERE job_id = $1 ORDER BY event_seq DESC LIMIT $2
       ) latest_events
       ORDER BY event_seq ASC`,
      [jobId, limit],
    );
    return result.rows.map(toOzEvent);
  }

  async createOzArtifact(jobId: string, type: string, name: string, data?: unknown, blobUrl?: string): Promise<OzArtifact> {
    const result = await this.query<OzArtifactRow>(
      `INSERT INTO oz_artifacts (job_id, type, name, data, blob_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [jobId, type, name, data === undefined ? null : JSON.stringify(data), blobUrl ?? null],
    );
    return toOzArtifact(result.rows[0]!);
  }

  async listOzArtifacts(jobId: string): Promise<OzArtifact[]> {
    const result = await this.query<OzArtifactRow>(
      "SELECT * FROM oz_artifacts WHERE job_id = $1 ORDER BY created_at ASC",
      [jobId],
    );
    return result.rows.map(toOzArtifact);
  }

  async appendOzFeedback(jobId: string, eventType: string, before?: unknown, after?: unknown): Promise<void> {
    await this.query(
      `INSERT INTO oz_feedback_events (job_id, event_type, before, after)
       VALUES ($1, $2, $3, $4)`,
      [
        jobId,
        eventType,
        before === undefined ? null : JSON.stringify(before),
        after === undefined ? null : JSON.stringify(after),
      ],
    );
  }

  private async hydrateRun(row: RunWithConfigRow): Promise<RunResult> {
    const [verdicts, events] = await Promise.all([
      this.query<VerdictRow>(
        "SELECT * FROM verdicts WHERE run_id = $1 ORDER BY assertion_index ASC",
        [row.id],
      ).then((result) => result.rows.map(toVerdict)),
      row.trace_s3_key ? this.blobs.getTrace(row.trace_s3_key) : Promise.resolve(null),
    ]);
    return this.toRun(row, row.config, events ?? [], verdicts);
  }

  private toRun(
    row: RunRow,
    config: EvalConfig,
    events: RunResult["events"],
    verdicts: Verdict[],
  ): RunResult {
    const gradeReport = row.grade_report ? (row.grade_report as GradeReport) : undefined;
    return {
      id: row.id,
      evalId: row.eval_id,
      evalTitle: titleFromTask(config.task),
      task: config.task,
      agentType: row.agent_type as RunResult["agentType"],
      status: row.status as RunResult["status"],
      errorType: row.error_type as RunResult["errorType"],
      startedAt: row.started_at ?? new Date().toISOString(),
      finishedAt: row.finished_at,
      durationSec: events.length ? Math.max(...events.map((event) => event.t)) : 0,
      totalSteps: row.total_steps,
      tokens: row.tokens,
      events,
      verdicts,
      gradeReport,
    };
  }

  private async query<Row extends QueryResultRow>(text: string, values?: unknown[]) {
    await this.schemaReady;
    return this.pool.query<Row>(text, values);
  }
}
