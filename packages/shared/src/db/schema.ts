/**
 * Postgres schema (Decision 7). Eval configs and run metadata live in Postgres;
 * full traces and report assets live in S3 (see {@link ../s3}).
 *
 * Exposed both as a raw DDL string (for migrations / `psql`) and as typed row
 * shapes so the runner and web can share the same model without an ORM.
 */

export const SCHEMA_SQL = /* sql */ `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Decision 8: GitHub OAuth users
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id   BIGINT UNIQUE NOT NULL,
  login       TEXT NOT NULL,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server-side web sessions. The browser receives only the opaque token; the DB
-- stores a one-way hash so a DB read cannot be replayed as a session cookie.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
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
  trace_s3_key  TEXT,                            -- full AgentEvent[] trace in S3 (Decision 7)
  grade_report  JSONB
);

-- Decision 5/6: one graded assertion outcome per row
CREATE TABLE IF NOT EXISTS verdicts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           UUID NOT NULL REFERENCES runs(id),
  assertion_index  INTEGER NOT NULL,
  type             TEXT NOT NULL,  -- shell|http|file|llm
  name             TEXT NOT NULL,
  passed           BOOLEAN NOT NULL,
  output           TEXT,
  hint             TEXT,
  evidence         JSONB,
  UNIQUE (run_id, assertion_index)
);

CREATE TABLE IF NOT EXISTS oz_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  input_url   TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'copilot',
  status      TEXT NOT NULL,
  state       JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oz_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES oz_jobs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  phase       TEXT NOT NULL,
  message     TEXT NOT NULL,
  dedupe_key  TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oz_artifacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES oz_jobs(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  data        JSONB,
  blob_url    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oz_feedback_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      UUID NOT NULL REFERENCES oz_jobs(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  before      JSONB,
  after       JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS evidence JSONB;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS grade_report JSONB;
ALTER TABLE oz_events ADD COLUMN IF NOT EXISTS dedupe_key TEXT;

CREATE INDEX IF NOT EXISTS idx_evals_user ON evals(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_eval ON runs(eval_id);
CREATE INDEX IF NOT EXISTS idx_verdicts_run ON verdicts(run_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_oz_jobs_user ON oz_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_oz_jobs_updated ON oz_jobs(updated_at);
CREATE INDEX IF NOT EXISTS idx_oz_events_job ON oz_events(job_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_oz_events_dedupe ON oz_events(job_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oz_artifacts_job ON oz_artifacts(job_id);
	`;

export interface UserRow {
  id: string;
  /** BIGINT values are returned as strings by node-postgres. */
  github_id: string;
  login: string;
  avatar_url: string | null;
  created_at: string;
}

export interface AuthSessionRow {
  token_hash: string;
  user_id: string;
  expires_at: string;
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
  grade_report: unknown | null;
}

export interface VerdictRow {
  id: string;
  run_id: string;
  assertion_index: number;
  type: string;
  name: string;
  passed: boolean;
  output: string | null;
  hint: string | null;
  evidence: unknown | null;
}

export interface OzJobRow {
  id: string;
  user_id: string;
  input_url: string;
  mode: string;
  status: string;
  state: unknown;
  created_at: string;
  updated_at: string;
}

export interface OzEventRow {
  id: string;
  job_id: string;
  kind: string;
  phase: string;
  message: string;
  dedupe_key: string | null;
  payload: unknown | null;
  created_at: string;
}

export interface OzArtifactRow {
  id: string;
  job_id: string;
  type: string;
  name: string;
  data: unknown | null;
  blob_url: string | null;
  created_at: string;
}
