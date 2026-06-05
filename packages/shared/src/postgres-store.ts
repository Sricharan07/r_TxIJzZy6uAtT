import { randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { SCHEMA_SQL, type EvalRow, type RunRow, type UserRow, type VerdictRow } from "./db/schema.js";
import { getBlobStore, type BlobStore } from "./s3.js";
import type { Eval, EvalConfig, GradeReport, GraderEvidence, RunResult, User, Verdict } from "./types.js";
import type { EvalSummary, KilnStore } from "./store.js";
import { MOCK_USER } from "./mock.js";

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

  async createEval(userId: string, config: EvalConfig): Promise<Eval> {
    const result = await this.query<EvalRow>(
      `INSERT INTO evals (user_id, config, share_token)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, config, `cfg_${randomUUID()}`],
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
          run.gradeReport ?? null,
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
            verdict.evidence ?? null,
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
