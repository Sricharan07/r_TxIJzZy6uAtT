/**
 * Pluggable agent interface (Decision 3).
 *
 * Every supported coding agent (claude-code, codex, cursor, …) is wrapped in an
 * adapter that conforms to {@link Agent}. The runner is agent-agnostic: it
 * builds an {@link AgentTask}, hands it to the adapter, and consumes the
 * resulting {@link AgentRun} — a stream of {@link AgentEvent}s plus token/step
 * tallies and an artifact-collection hook.
 *
 * Keeping this surface tiny is what makes the runner pluggable: adding a new
 * agent means writing one adapter and registering it in `registry.ts`, with no
 * changes to the worker, sandbox, or grader.
 */
import type { AgentType, AgentEvent, EvalConfig } from "@kiln/shared";
import type { SandboxHandle } from "@kiln/grader";

/**
 * Everything an adapter needs to run one eval.
 *
 * The adapter executes inside `sandbox` (the same handle the grader will later
 * inspect), driven by `config`. `prompt` is the fully-assembled instruction the
 * agent receives — the task text with ingested context already prepended by the
 * worker (Decision 15), so adapters don't each re-implement context assembly.
 */
export interface AgentTask {
  config: EvalConfig;
  /** The sandbox the agent runs inside; later inspected by the grader. */
  sandbox: SandboxHandle;
  /** Task + ingested context, assembled by the worker, ready to feed the agent. */
  prompt: string;
}

/**
 * The result of driving an agent to completion.
 *
 * `events` is the ordered execution trace surfaced in the report timeline
 * (Decision 11). `tokens`/`steps` are tallies shown in the run header. Adapters
 * accumulate these while the agent works; the worker reads them once the run
 * resolves. {@link collectArtifacts} flushes anything the agent produced (e.g.
 * uploading generated files) so the sandbox is in its final state before the
 * grader probes it.
 */
export interface AgentRun {
  /** Ordered event stream mirroring the agent session (Decision 11). */
  events: AgentEvent[];
  /** Total tokens consumed by the agent (best-effort tally). */
  tokens: number;
  /** Number of discrete steps/tool-calls the agent took. */
  steps: number;
  /**
   * Finalize the run: flush buffers, persist generated files, etc. Called once,
   * after the agent loop ends and before grading. No-op for simple adapters.
   */
  collectArtifacts(): Promise<void>;
}

/** A single agent adapter (Decision 3). */
export interface Agent {
  /** The agent runtime this adapter speaks for. */
  type: AgentType;
  /** Drive the agent to completion against `task`, returning its trace. */
  startTask(task: AgentTask): Promise<AgentRun>;
}
