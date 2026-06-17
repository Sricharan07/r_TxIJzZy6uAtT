import Link from "next/link";
import type { Metadata } from "next";
import {
  summarize,
  formatDuration,
  type AgentType,
  type Finding,
  type GradeReport,
  type RunResult,
  type Severity,
} from "@kiln/shared";
import { getStore } from "@kiln/shared/store";
import { ShareBar } from "../../../components/ShareBar";
import { RunningReport } from "../../../components/RunningReport";

export const dynamic = "force-dynamic";

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

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function score(value: number): string {
  return Math.round(value).toString();
}

function severityClass(severity: Severity): string {
  return `severity-${severity}`;
}

// OG card per report (Decision 13) — drives the Slack/PR unfurl.
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const run = await getStore().getRun(id);
  if (!run) return {};
  const { passed, total } = summarize(run);
  const title =
    run.gradeReport
      ? `${run.evalTitle} — Grade ${run.gradeReport.score.letter}`
      : run.errorType === null
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
  const report = run.gradeReport;
  const passedLabel = report ? `GRADE ${report.score.letter}` : ok ? "PASSED" : "FAILED";
  const passedClass = report ? (report.taskPassed ? "badge-pass" : "badge-fail") : ok ? "badge-pass" : "badge-fail";
  const reportUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/reports/${run.id}`;
  const evalRecord = await getStore().getEval(run.evalId);
  const evalConfigHref = evalRecord ? `/evals/${evalRecord.shareToken}` : `/evals/${run.evalId}`;

  return (
    <div>
      {/* Sticky summary (Decision 9) */}
      <div className="report-sticky">
        <div className="report-sticky-left">
          <span className={`badge ${passedClass}`}>{passedLabel}</span>
          <span className="report-title">{run.evalTitle}</span>
          <span className="report-meta">
            {shortDuration(run.durationSec)} · {agentLabel(run.agentType)} ·{" "}
            {shortDate(run.startedAt)}
          </span>
        </div>
        <div className="report-actions">
          <Link className="btn btn-ghost" href={evalConfigHref}>
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
        <section className="report-hero">
          <div>
            <p className="eyebrow">Agent readiness report</p>
            <h1>{run.evalTitle}</h1>
            <p>
              {report
                ? `${report.score.passedRuns}/${report.score.runs} runs passed with ${report.findings.length} finding${report.findings.length === 1 ? "" : "s"} surfaced.`
                : `${passed}/${total} assertions passed in this run.`}
            </p>
          </div>
          <div className={`report-grade-orb ${report?.taskPassed ?? ok ? "pass" : "fail"}`}>
            <span>{report ? "Grade" : "Result"}</span>
            <strong>{report?.score.letter ?? `${passed}/${total}`}</strong>
          </div>
        </section>

        {/* Stats grid (Decision 9) */}
        {report ? (
          <GradeSummary report={report} run={run} />
        ) : (
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
        )}

        {report && <GradeDetails report={report} />}

        {/* Verdicts (Decisions 5, 6) */}
        <div className="section-title">Assertion Verdicts</div>
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

function GradeSummary({ report, run }: { report: GradeReport; run: RunResult }) {
  const cap = report.score.cap;
  return (
    <div className="stats-grid grade-stats">
      <div className="stat-card">
        <div className="stat-label">Grade</div>
        <div className={`stat-value grade-value ${report.taskPassed ? "pass" : "fail"}`}>
          {report.score.letter}
        </div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Raw Score</div>
        <div className="stat-value">{score(report.score.raw)}</div>
        {cap && (
          <div className="stat-subtle">
            capped at {cap.maxGrade} · {cap.reason}
          </div>
        )}
      </div>
      <div className="stat-card">
        <div className="stat-label">Pass Rate</div>
        <div className="stat-value">{pct(report.score.passRate)}</div>
        <div className="stat-subtle">
          CI {pct(report.score.confidenceInterval.low)}-{pct(report.score.confidenceInterval.high)}
        </div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Runs</div>
        <div className="stat-value">
          {report.score.passedRuns}/{report.runGroup?.expectedRuns ?? report.score.runs}
        </div>
        {report.runGroup && (
          <div className="stat-subtle">
            {report.runGroup.completedRuns}/{report.runGroup.expectedRuns} complete · {report.runGroup.status}
          </div>
        )}
      </div>
      <div className="stat-card">
        <div className="stat-label">Findings</div>
        <div className="stat-value">{report.findings.length}</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Tokens</div>
        <div className="stat-value">{Math.round(run.tokens / 1000)}k</div>
      </div>
    </div>
  );
}

function GradeDetails({ report }: { report: GradeReport }) {
  return (
    <>
      <div className="section-title">Agent / Model Matrix</div>
      <div className="agent-matrix">
        {report.agentMatrix.map((row) => (
          <div key={`${row.agentType}-${row.modelId}`} className="agent-matrix-row">
            <span>{agentLabel(row.agentType)}</span>
            <span>{row.modelId}</span>
            <span>
              {row.passedRuns}/{row.runs} passed
            </span>
            <span>{pct(row.passRate)}</span>
          </div>
        ))}
      </div>

      {report.stability && (
        <>
          <div className="section-title">Stability</div>
          <div className={`stability ${report.stability.stable ? "stable" : "unstable"}`}>
            <strong>{report.stability.stable ? "Stable" : "Variance Flagged"}</strong>
            <span>{report.stability.note}</span>
          </div>
        </>
      )}

      {report.traceMetrics && (
        <>
          <div className="section-title">Trace Metrics</div>
          <div className="trace-metrics">
            <span>steps {report.traceMetrics.totalSteps}</span>
            <span>tokens {Math.round(report.traceMetrics.tokens / 1000)}k</span>
            <span>retries {report.traceMetrics.retryCount}</span>
            <span>loops {report.traceMetrics.loopOnSameErrorCount}</span>
            <span>API errors {report.traceMetrics.apiErrorCount}</span>
            <span>rescues {report.traceMetrics.humanRescueCount}</span>
          </div>
        </>
      )}

      <div className="section-title">Findings</div>
      {report.findings.length === 0 ? (
        <div className="empty-findings">No confirmed or advisory findings.</div>
      ) : (
        <div className="findings">
          {report.findings.map((finding) => (
            <FindingRow key={finding.id} finding={finding} />
          ))}
        </div>
      )}

      {report.remediationProjection && (
        <div className="projection">
          <span className="projection-grade">{report.score.letter}</span>
          <span className="projection-arrow">→</span>
          <span className="projection-grade">{report.remediationProjection.letter}</span>
          <span>{report.remediationProjection.summary}</span>
        </div>
      )}

      <div className="section-title">Slice 1 Gate</div>
      <div className="definition-checks">
        {report.definitionOfDone.map((check) => (
          <div key={check.id} className={`definition-check ${check.passed ? "pass" : "fail"}`}>
            <span>{check.passed ? "✓" : "✗"}</span>
            <strong>{check.label}</strong>
            <em>{check.detail}</em>
          </div>
        ))}
      </div>
    </>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <div className={`finding-row ${finding.status}`}>
      <div className="finding-header">
        <span className={`severity-pill ${severityClass(finding.severity)}`}>
          {finding.severity}
        </span>
        <span className="finding-title">{finding.title}</span>
        <span className="finding-code">{finding.code}</span>
        <span className="finding-status">{finding.status}</span>
      </div>
      {finding.hardCapGrade && (
        <div className="finding-cap">Hard cap: maximum grade {finding.hardCapGrade}</div>
      )}
      {finding.evidence.map((evidence, idx) => (
        <div key={`${finding.id}-evidence-${idx}`} className="evidence-block">
          <div className="evidence-meta">
            <span>{evidence.type}</span>
            <span>{Math.round(evidence.confidence * 100)}% confidence</span>
            <span>{evidence.redactionStatus}</span>
          </div>
          <pre className="replay-cmd">{evidence.replayCmd}</pre>
          <pre className="customer-excerpt">{evidence.customerExcerpt}</pre>
        </div>
      ))}
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
