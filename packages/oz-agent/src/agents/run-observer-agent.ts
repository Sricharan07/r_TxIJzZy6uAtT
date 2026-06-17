import type { AgentEvent, OzEvent } from "@kiln/shared";

function clip(text: string): string {
  return text.length > 500 ? text.slice(0, 497) + "..." : text;
}

export function observeRunEvent(jobId: string, phase: OzEvent["phase"], event: AgentEvent, dedupeKey?: string): OzEvent {
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
    message: `${prefix}: ${clip(event.text)}`,
    dedupeKey,
    payload: {
      severity,
      eventKind: event.kind,
      t: event.t,
      annotation: event.annotation ? clip(event.annotation) : undefined,
    },
  };
}
