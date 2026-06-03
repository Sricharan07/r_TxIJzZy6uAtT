/**
 * Kiln shared types — the contract between web, runner, and grader.
 *
 * An eval is "task + context + assertions". The runner executes an agent in a
 * sandbox against that config and emits a stream of {@link AgentEvent}s; the
 * grader turns the agent's artifacts into {@link Verdict}s. The web app renders
 * the resulting {@link RunResult}.
 */

/** Supported agent runtimes the eval targets (Decision 4). */
export type Language = "node" | "python" | "go" | "other";

/** Pluggable agent adapters (Decision 3). */
export type AgentType = "claude-code" | "codex" | "cursor";

/** Where a piece of context comes from (Decision 15). */
export type ContextSourceType = "url" | "repo" | "file" | "paste";

/**
 * A single context input the agent will see. URLs and repos are re-fetchable on
 * re-runs so context stays fresh; files and pastes are stored verbatim.
 */
export interface ContextSource {
  type: ContextSourceType;
  /** Display label, e.g. the URL, repo path, or filename. */
  label: string;
  /** For `url`: how deep to crawl. `single` = just this page. */
  crawlDepth?: "single" | "linked";
  /** For `repo`: directories/globs to include. */
  paths?: string[];
  /** For `file`/`paste`: the literal content. */
  content?: string;
}

/** Assertion kinds (Decisions 5 & 16). Shell/http/file are deterministic; llm is AI-judged. */
export type AssertionType = "shell" | "http" | "file" | "llm";

/** A single pass/fail test definition. The `config` shape depends on `type`. */
export interface Assertion {
  type: AssertionType;
  /** Human-readable name shown in the report verdicts. */
  name: string;
  config: ShellAssertion | HttpAssertion | FileAssertion | LlmAssertion;
}

export interface ShellAssertion {
  /** Command that must exit 0. */
  command: string;
  /** Optional working directory inside the sandbox. */
  cwd?: string;
}

export interface HttpAssertion {
  url: string;
  /** Expected status code (default 200). */
  expectStatus?: number;
  /** Optional substring the response body must contain. */
  expectBodyContains?: string;
}

export interface FileAssertion {
  path: string;
  /** When set, the file must contain this string (otherwise existence is enough). */
  contains?: string;
}

export interface LlmAssertion {
  /** Natural-language criterion, e.g. "Code follows SDK recommended patterns". */
  criterion: string;
}

/** The full eval definition stored as JSONB (Decision 4). */
export interface EvalConfig {
  task: string;
  language: Language;
  context: ContextSource[];
  assertions: Assertion[];
  metadata: {
    agentType: AgentType;
    /** Hard sandbox timeout in seconds. */
    timeoutSec: number;
  };
}

/** A persisted eval (Decision 19 — every config has a shareable URL). */
export interface Eval {
  id: string;
  userId: string;
  config: EvalConfig;
  createdAt: string;
  /** Unguessable token used for the shareable config URL. */
  shareToken: string;
}

/** Lifecycle status of a run (Decision 11 / 18). */
export type RunStatus = "pending" | "running" | "completed" | "errored";

/** Distinguishes the user's API signal from our infra failures (Decision 18). */
export type ErrorType = null | "platform" | "timeout";

/** One step in the agent's execution trace (Decision 3 / 6 / 11). */
export interface AgentEvent {
  /** Seconds since run start. */
  t: number;
  kind: "info" | "command" | "file" | "api" | "warn" | "fail";
  text: string;
  /** Expanded failure explanation rendered inline in the timeline. */
  annotation?: string;
}

/** A single graded assertion outcome (Decision 5 / 6). */
export interface Verdict {
  assertionIndex: number;
  type: AssertionType;
  name: string;
  passed: boolean;
  /** Captured command/HTTP/file output or judge reasoning. */
  output?: string;
  /** Short "what to fix" hint shown on failures. */
  hint?: string;
}

/** A complete run, server-rendered into the report page (Decisions 6, 7, 9). */
export interface RunResult {
  id: string;
  evalId: string;
  evalTitle: string;
  task: string;
  agentType: AgentType;
  status: RunStatus;
  errorType: ErrorType;
  startedAt: string;
  finishedAt: string | null;
  durationSec: number;
  totalSteps: number;
  tokens: number;
  events: AgentEvent[];
  verdicts: Verdict[];
}

/** GitHub-authenticated user (Decision 8). */
export interface User {
  id: string;
  /** GitHub's numeric identity. Present for OAuth-backed users. */
  githubId?: number;
  login: string;
  avatarUrl: string;
  createdAt: string;
}

/** Derived pass/fail summary used across the report, OG card, and diff. */
export interface RunSummary {
  passed: number;
  total: number;
  /** A run "passes" only when every assertion passes and there was no platform error. */
  ok: boolean;
}

export function summarize(run: RunResult): RunSummary {
  const total = run.verdicts.length;
  const passed = run.verdicts.filter((v) => v.passed).length;
  return { passed, total, ok: run.errorType === null && total > 0 && passed === total };
}

/** mm:ss formatting for durations. */
export function formatDuration(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
