import { ImageResponse } from "next/og";
import { summarize, formatDuration, type RunResult } from "@kiln/shared";
import { getStore } from "@kiln/shared/store";

/**
 * Decision 13 — Dynamic Open Graph image for a report.
 *
 * This route produces the 1200x630 card that Slack/GitHub render when a report
 * URL is unfurled. It reproduces the OG design: muted "kiln.dev" label, a
 * PASSED/FAILED badge, the eval title, a stats subtitle, a one-line failure
 * summary, and a pass/fail footer row.
 *
 * Notes / honesty:
 * - `next/og` (Satori) only understands a flexbox subset of CSS. Every
 *   container therefore sets `display: "flex"` and uses inline style objects
 *   only (no className / external CSS), per the ImageResponse constraints.
 * - The one-line summary is derived from the first failed verdict when present.
 */

export const runtime = "nodejs";

// Palette (matches the report page surfaces).
const BG = "#09090b";
const SURFACE = "#18181b";
const TEXT = "#fafafa";
const MUTED = "#a1a1aa";
const FAINT = "#71717a";
const RED = "#dc2626";
const GREEN = "#22c55e";
const YELLOW = "#f59e0b";

function failureSummary(run: RunResult): string {
  if (run.errorType !== null) return "Run stopped due to a platform issue.";
  const finding = run.gradeReport?.findings[0];
  if (finding) return finding.evidence[0]?.customerExcerpt ?? finding.title;
  const failed = run.verdicts.find((v) => !v.passed);
  if (failed) return failed.hint ?? failed.output ?? "One or more assertions failed.";
  if (run.status === "pending" || run.status === "running") return "Eval is still running.";
  return "All configured assertions passed.";
}

/** Minimal placeholder card used when the report id is unknown. */
function notFoundCard(): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: BG,
          color: MUTED,
          fontSize: 40,
        }}
      >
        Report not found
      </div>
    ),
    { width: 1200, height: 630 },
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<ImageResponse> {
  const { id } = await params;
  const run: RunResult | null = await getStore().getRun(id);
  if (!run) return notFoundCard();

  const { passed, total, ok } = summarize(run);
  const failed = total - passed;
  const grade = run.gradeReport?.score.letter;
  const reportPassed = run.gradeReport?.taskPassed ?? ok;
  const badgeColor = run.errorType !== null ? YELLOW : reportPassed ? GREEN : RED;
  const badgeLabel = run.errorType !== null ? "PLATFORM ERROR" : grade ? `GRADE ${grade}` : ok ? "PASSED" : "FAILED";
  const duration = formatDuration(run.durationSec);
  const subtitle =
    run.errorType !== null
      ? `Run interrupted · ${run.agentType} · ${duration}`
      : run.gradeReport
      ? `${Math.round(run.gradeReport.score.passRate * 100)}% pass rate · ${run.agentType} · ${duration}`
      : `${passed}/${total} tests passed · ${run.agentType} · ${duration}`;

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          padding: 64,
          backgroundColor: BG,
          fontFamily: "sans-serif",
        }}
      >
        {/* Top-left brand label */}
        <div style={{ display: "flex", color: FAINT, fontSize: 28, letterSpacing: 0 }}>
          kiln.dev
        </div>

        {/* Card body */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            marginTop: 40,
            padding: 56,
            borderRadius: 24,
            backgroundColor: SURFACE,
          }}
        >
          {/* Status badge */}
          <div style={{ display: "flex" }}>
            <div
              style={{
                display: "flex",
                paddingTop: 10,
                paddingBottom: 10,
                paddingLeft: 24,
                paddingRight: 24,
                borderRadius: 9999,
                backgroundColor: badgeColor,
                color: "#ffffff",
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: 0,
              }}
            >
              {badgeLabel}
            </div>
          </div>

          {/* Eval title */}
          <div
            style={{
              display: "flex",
              marginTop: 36,
              color: TEXT,
              fontSize: 64,
              fontWeight: 700,
              lineHeight: 1.1,
            }}
          >
            {run.evalTitle}
          </div>

          {/* Stats subtitle */}
          <div style={{ display: "flex", marginTop: 24, color: MUTED, fontSize: 34 }}>
            {subtitle}
          </div>

          {/* One-line failure summary */}
          <div style={{ display: "flex", marginTop: 28, color: FAINT, fontSize: 28 }}>
            {failureSummary(run)}
          </div>
        </div>

        {/* Footer pass/fail row */}
        <div style={{ display: "flex", marginTop: 40, fontSize: 34, fontWeight: 600 }}>
          <div style={{ display: "flex", color: GREEN, marginRight: 48 }}>
            {`[PASS] ${passed} passed`}
          </div>
          <div style={{ display: "flex", color: RED }}>{`[FAIL] ${failed} failed`}</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
