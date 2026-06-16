"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentEvent, RunResult } from "@kiln/shared/types";
import { formatDuration } from "@kiln/shared/types";

export function RunningReport({ run }: { run: RunResult }) {
  const router = useRouter();
  const [events, setEvents] = useState<AgentEvent[]>(run.events);

  useEffect(() => {
    const source = new EventSource(`/api/events?runId=${encodeURIComponent(run.id)}`);
    source.onmessage = (event) => {
      const parsed = JSON.parse(event.data) as AgentEvent;
      setEvents((current) => {
        if (current.some((e) => e.t === parsed.t && e.text === parsed.text)) return current;
        return [...current, parsed];
      });
    };
    source.addEventListener("done", () => {
      source.close();
      router.refresh();
    });
    return () => source.close();
  }, [router, run.id]);

  return (
    <div>
      <div className="report-sticky">
        <div className="report-sticky-left">
          <span className="run-dot" />
          <span className="report-title">Running — {run.evalTitle}</span>
        </div>
      </div>
      <div className="running-panel">
        <div className="section-title">Live Execution Timeline</div>
        <div className="timeline">
          {events.length === 0 && (
            <div className="tl-item">
              <div className="tl-dot" />
              <span className="tl-time">0:00</span>
              <span className="tl-text">Queued run, waiting for runner</span>
            </div>
          )}
          {events.map((e, i) => (
            <div key={`${e.t}-${i}`}>
              <div className="tl-item">
                <div className={`tl-dot${e.kind === "fail" ? " fail" : ""}`} />
                <span className="tl-time">{formatDuration(e.t)}</span>
                <span className={`tl-text${e.kind === "fail" ? " fail" : ""}`}>{e.text}</span>
              </div>
              {e.annotation && (
                <div className="tl-annotation">
                  <strong>Why it failed:</strong> {e.annotation}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="run-note">
          Agent is actively working. This page updates live and becomes the final report when done.
        </div>
      </div>
    </div>
  );
}
