"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentEvent, RunResult } from "@kiln/shared/types";
import { formatDuration } from "@kiln/shared/types";

export function RunningReport({ run }: { run: RunResult }) {
  const router = useRouter();
  const [events, setEvents] = useState<AgentEvent[]>(run.events);
  const failures = events.filter((event) => event.kind === "fail").length;
  const lastEvent = events.at(-1);
  const elapsed = lastEvent?.t ?? run.durationSec ?? 0;

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
    <div className="run-console">
      <div className="report-sticky">
        <div className="report-sticky-left">
          <span className="run-dot" />
          <span className="report-title">Live run</span>
          <span className="report-meta">{run.evalTitle}</span>
        </div>
        <div className="report-actions">
          <span className="live-chip">Streaming</span>
        </div>
      </div>

      <div className="running-panel">
        <section className="run-hero">
          <div>
            <p className="eyebrow">Agent execution</p>
            <h1>{run.evalTitle}</h1>
            <p>{lastEvent?.text ?? "Queued run, waiting for the runner to start."}</p>
          </div>
          <div className="run-metrics">
            <div>
              <span>Elapsed</span>
              <strong>{formatDuration(elapsed)}</strong>
            </div>
            <div>
              <span>Events</span>
              <strong>{events.length}</strong>
            </div>
            <div>
              <span>Failures</span>
              <strong>{failures}</strong>
            </div>
          </div>
        </section>

        <section className="live-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Live timeline</p>
              <h2>What the agent is doing</h2>
            </div>
            <span className="live-chip">Auto-updating</span>
          </div>
          <div className="timeline refined">
            {events.length === 0 && (
              <div className="tl-item">
                <div className="tl-dot active" />
                <span className="tl-time">0:00</span>
                <span className="tl-text active">Queued run, waiting for runner</span>
              </div>
            )}
            {events.map((e, i) => (
              <div key={`${e.t}-${i}`}>
                <div className="tl-item">
                  <div className={`tl-dot${e.kind === "fail" ? " fail" : i === events.length - 1 ? " active" : ""}`} />
                  <span className="tl-time">{formatDuration(e.t)}</span>
                  <span className={`tl-text${e.kind === "fail" ? " fail" : i === events.length - 1 ? " active" : ""}`}>{e.text}</span>
                </div>
                {e.annotation && (
                  <div className="tl-annotation">
                    <strong>Diagnosis:</strong> {e.annotation}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="run-note">
            This page becomes the final report when the run finishes.
          </div>
        </section>
      </div>
    </div>
  );
}
