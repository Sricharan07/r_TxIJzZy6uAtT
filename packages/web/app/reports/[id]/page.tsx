import Link from "next/link";
import type { Metadata } from "next";
import { summarize, formatDuration, type RunResult, type AgentType } from "@kiln/shared";
import { getStore } from "@kiln/shared/store";
import { ShareBar } from "../../../components/ShareBar";
import { RunningReport } from "../../../components/RunningReport";

const AGENT_LABEL: Record<AgentType, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

function agentLabel(t: AgentType): string {
  return AGENT_LABEL[t];
}

function shortDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// OG card per report (Decision 13) — drives the Slack/PR unfurl.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const run = await getStore().getRun(id);
  if (!run) return {};
  const { passed, total } = summarize(run);
  const title =
    run.errorType === null
      ? `${run.evalTitle} — ${passed}/${total} tests passed`
      : `${run.evalTitle} — platform error`;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const imageUrl = `${appUrl}/reports/${id}/og`;
  return {
    title,
    openGraph: { title, images: [imageUrl] },
    twitter: { card: "summary_large_image", title, images: [imageUrl] },
  };
}

/** Report page — sticky summary + stats + verdicts + timeline (Decisions 6, 9). */
export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getStore().getRun(id);
  if (!run) {
    return (
      <div className="report-body">
        <p style={{ color: "var(--text-muted)" }}>Report not found.</p>
      </div>
    );
  }

  // Platform/infra failure gets its own treatment, never blamed on the API (Decision 18).
  if (run.errorType !== null) {
    return <PlatformError run={run} />;
  }
  if (run.status === "pending" || run.status === "running") {
    return <RunningReport run={run} />;
  }

  const { passed, total, ok } = summarize(run);
  const reportUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/reports/${run.id}`;

  return (
    <div>
      {/* Sticky summary (Decision 9) */}
      <div className="report-sticky">
        <div className="report-sticky-left">
          <span className={`badge ${ok ? "badge-pass" : "badge-fail"}`}>
            {ok ? "PASSED" : "FAILED"}
          </span>
          <span className="report-title">{run.evalTitle}</span>
          <span className="report-meta">
            {shortDuration(run.durationSec)} · {agentLabel(run.agentType)} ·{" "}
            {shortDate(run.startedAt)}
          </span>
        </div>
        <div className="report-actions">
          <Link className="btn btn-ghost" href={`/evals/${run.evalId}`}>
            Eval Config
          </Link>
          <Link className="btn btn-primary" href={`/evals/new?from=${run.evalId}`}>
            Re-run Eval
          </Link>
        </div>
      </div>

      {/* Share bar (Decision 19) */}
      <ShareBar url={reportUrl} />

      <div className="report-body">
        {/* Stats grid (Decision 9) */}
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">Tests</div>
            <div className="stat-value">
              <span style={{ color: "var(--green)" }}>{passed}</span>{" "}
              <span style={{ color: "var(--text-dim)" }}>/</span> {total}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Agent Steps</div>
            <div className="stat-value">{run.totalSteps}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Duration</div>
            <div className="stat-value">{formatDuration(run.durationSec)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Tokens</div>
            <div className="stat-value">{Math.round(run.tokens / 1000)}k</div>
          </div>
        </div>

        {/* Verdicts (Decisions 5, 6) */}
        <div className="section-title">Test Verdicts</div>
        <div className="verdicts">
          {run.verdicts.map((v) => (
            <div
              key={v.assertionIndex}
              className={`verdict-row${v.passed ? "" : " fail"}`}
            >
              <span
                className="verdict-icon"
                style={{ color: v.passed ? "var(--green)" : "var(--red)" }}
              >
                {v.passed ? "✓" : "✗"}
              </span>
              <span className="verdict-name">{v.name}</span>
              {v.type === "llm" && <span className="verdict-llm">LLM judge</span>}
              {v.hint && <span className="verdict-hint">{v.hint}</span>}
              {v.output && <pre className="verdict-output">{v.output}</pre>}
            </div>
          ))}
        </div>

        {/* Execution timeline (Decisions 6, 11) */}
        <div className="section-title">Execution Timeline</div>
        <div className="timeline">
          {run.events.map((e, i) => {
            const isFail = e.kind === "fail";
            return (
              <div key={i}>
                <div className="tl-item">
                  <div className={`tl-dot${isFail ? " fail" : ""}`} />
                  <span className="tl-time">{formatDuration(e.t)}</span>
                  <span className={`tl-text${isFail ? " fail" : ""}`}>{e.text}</span>
                </div>
                {e.annotation && (
                  <div className="tl-annotation">
                    <strong>Why it failed:</strong> {e.annotation}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Platform-error state — yellow/gray, free retry, no verdicts (Decision 18). */
function PlatformError({ run }: { run: RunResult }) {
  const reason =
    run.errorType === "timeout"
      ? "The sandbox timed out before the agent could complete."
      : "An internal error occurred while running your eval.";
  return (
    <div>
      <div className="report-sticky">
        <div className="report-sticky-left">
          <span className="badge badge-error">PLATFORM ERROR</span>
          <span className="report-title">{run.evalTitle}</span>
        </div>
      </div>
      <div className="platform-error">
        <span className="badge badge-error" style={{ fontSize: "13px" }}>
          ⚠ Platform Issue
        </span>
        <h3>Eval couldn&apos;t complete</h3>
        <p>
          {reason} This is a platform issue, not a problem with your API or docs.
          This run won&apos;t count toward your monthly limit.
        </p>
        <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
          <Link className="btn btn-primary" href={`/evals/new?from=${run.evalId}`}>
            Retry (free)
          </Link>
          <Link className="btn btn-ghost" href={`/api/events?runId=${run.id}`}>
            View Partial Trace
          </Link>
        </div>
      </div>
    </div>
  );
}
