/**
 * Claude Code agent adapter (Decision 3).
 *
 * PRODUCTION: this adapter shells out to the `claude` CLI *inside* the
 * Firecracker sandbox (Decision 2). It streams the CLI's structured JSON output
 * (`claude -p <prompt> --output-format stream-json`), translating each tool-use
 * / file-edit / message event into an {@link AgentEvent} and tallying tokens and
 * steps as they arrive.
 *
 * SANDBOX/DEV: the `claude` CLI and live model access are unavailable in this
 * environment, so when the binary is absent we emit a *simulated* event stream
 * that mirrors the shape and pacing of a real session. The simulation is
 * deterministic (derived from the task text) so re-runs are reproducible and it
 * is clearly labelled — it does not claim the agent actually succeeded.
 */
import type { AgentEvent } from "@kiln/shared";
import type { Agent, AgentRun, AgentTask } from "./interface.js";

/**
 * Whether the real `claude` CLI is available in the sandbox.
 *
 * Stubbed to `false` here: the sandbox cannot run the CLI or reach the model.
 * In production this would probe `sandbox.exec("command -v claude")`.
 */
function claudeCliAvailable(): boolean {
  return false;
}

/**
 * Build a deterministic, realistic-looking event trace for one task.
 *
 * Timestamps and the event list are derived purely from the prompt so the
 * output is reproducible (Decision: deterministic ids/streams). This stands in
 * for the real CLI's `stream-json` output during dev.
 */
function simulateSession(prompt: string): AgentEvent[] {
  // A small deterministic "clock": each step advances by a fixed cadence so the
  // timeline looks paced without depending on wall-clock time.
  let t = 0;
  const step = 8;
  const at = (): number => (t += step);
  const head = prompt.split("\n", 1)[0]?.slice(0, 80) ?? "task";

  return [
    { t: at(), kind: "info", text: `Claude Code session started (simulated). Goal: ${head}` },
    { t: at(), kind: "info", text: "Reading provided context and planning approach" },
    { t: at(), kind: "command", text: "ls -la" },
    { t: at(), kind: "command", text: "cat package.json" },
    { t: at(), kind: "file", text: "Created src/index.ts" },
    { t: at(), kind: "api", text: "Initialized SDK client from context docs" },
    { t: at(), kind: "file", text: "Edited src/index.ts (added integration logic)" },
    { t: at(), kind: "command", text: "npm install" },
    {
      t: at(),
      kind: "warn",
      text: "Type mismatch on first attempt",
      annotation: "Simulated: the agent corrected a parameter shape against the SDK types.",
    },
    { t: at(), kind: "file", text: "Edited src/index.ts (fixed types)" },
    { t: at(), kind: "command", text: "npm run build" },
    { t: at(), kind: "info", text: "Session complete (simulated)" },
  ];
}

export class ClaudeCodeAgent implements Agent {
  readonly type = "claude-code" as const;

  async startTask(task: AgentTask): Promise<AgentRun> {
    const events: AgentEvent[] = [];

    if (claudeCliAvailable()) {
      // PRODUCTION PATH (not reachable in sandbox):
      //   const proc = sandbox.exec(`claude -p ${shellQuote(task.prompt)} \
      //       --output-format stream-json`);
      //   for await (const line of proc.stdout) { events.push(translate(line)); }
      // The translate() step maps CLI event kinds → AgentEvent.kind and sums
      // usage.input_tokens + usage.output_tokens into `tokens`.
      throw new Error("Real claude CLI path is not available in this environment.");
    }

    // DEV/SANDBOX PATH: deterministic simulated stream.
    for (const e of simulateSession(task.prompt)) events.push(e);

    // Step/token tallies derived from the simulated trace (deterministic).
    const steps = events.filter((e) => e.kind === "command" || e.kind === "file").length;
    const tokens = 1_200 * steps; // rough, stable estimate for the simulated run

    return {
      events,
      tokens,
      steps,
      async collectArtifacts(): Promise<void> {
        // PRODUCTION: copy generated files out of the microVM / snapshot the
        // working tree. SIMULATED: nothing to flush — files were written
        // directly to the (simulated) sandbox by the steps above.
      },
    };
  }
}
