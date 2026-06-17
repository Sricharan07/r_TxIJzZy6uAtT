import type { AgentEvent, OzEvent } from "@kiln/shared";

export function observeRunEvent(jobId: string, phase: OzEvent["phase"], event: AgentEvent): OzEvent {
  const severity = event.kind === "fail" ? "critical" : event.kind === "warn" ? "warning" : "info";
  const prefix =
    event.kind === "command"
      ? "Agent ran a command"
      : event.kind === "file"
        ? "Agent changed files"
        : event.kind === "api"
          ? "Agent interacted with an API"
          : event.kind === "fail"
            ? "Agent hit a failure"
            : "Agent progress";
  return {
    jobId,
    kind: "run.observation",
    phase,
    message: `${prefix}: ${event.text}`,
    payload: { severity, sourceEvent: event },
  };
}
