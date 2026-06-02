/**
 * Postgres schema (Decision 7). Eval configs and run metadata live in Postgres;
 * full traces and report assets live in S3 (see {@link ../s3}).
 *
 * Exposed both as a raw DDL string (for migrations / `psql`) and as typed row
 * shapes so the runner and web can share the same model without an ORM.
 */

export const SCHEMA_SQL = /* sql */ `
-- Decision 8: GitHub OAuth users
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id   BIGINT UNIQUE NOT NULL,
  login       TEXT NOT NULL,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Decision 4: eval config stored as JSONB; Decision 19: share_token for the config URL
CREATE TABLE IF NOT EXISTS evals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  config       JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  share_token  TEXT UNIQUE NOT NULL
);

-- Decision 6/11/18: one execution of an eval
CREATE TABLE IF NOT EXISTS runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  eval_id       UUID NOT NULL REFERENCES evals(id),
  agent_type    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|running|completed|errored
  error_type    TEXT,                            -- null|platform|timeout (Decision 18)
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  total_steps   INTEGER NOT NULL DEFAULT 0,
  tokens        INTEGER NOT NULL DEFAULT 0,
  trace_s3_key  TEXT                             -- full AgentEvent[] trace in S3 (Decision 7)
);

-- Decision 5/6: one graded assertion outcome per row
CREATE TABLE IF NOT EXISTS verdicts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID NOT NULL REFERENCES runs(id),
  assertion_index  INTEGER NOT NULL,
  type             TEXT NOT NULL,  -- shell|http|file|llm
  passed           BOOLEAN NOT NULL,
  output           TEXT,
  hint             TEXT
);

CREATE INDEX IF NOT EXISTS idx_evals_user ON evals(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_eval ON runs(eval_id);
CREATE INDEX IF NOT EXISTS idx_verdicts_run ON verdicts(run_id);
`;

export interface UserRow {
  id: string;
  github_id: number;
  login: string;
  avatar_url: string | null;
  created_at: string;
}

export interface EvalRow {
  id: string;
  user_id: string;
  /** JSONB column — an EvalConfig. */
  config: unknown;
  created_at: string;
  share_token: string;
}

export interface RunRow {
  id: string;
  eval_id: string;
  agent_type: string;
  status: string;
  error_type: string | null;
  started_at: string | null;
  finished_at: string | null;
  total_steps: number;
  tokens: number;
  trace_s3_key: string | null;
}

export interface VerdictRow {
  id: string;
  run_id: string;
  assertion_index: number;
  type: string;
  passed: boolean;
  output: string | null;
  hint: string | null;
}
