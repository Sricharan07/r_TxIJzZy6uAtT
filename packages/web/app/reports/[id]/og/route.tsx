import { ImageResponse } from "next/og";
import { getRun, summarize, formatDuration, type RunResult } from "@kiln/shared";

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
 * - The one-line failure summary is currently a fixed exemplar string. Real
 *   runs would derive this from the failing verdict's `hint`/`output`; that
 *   derivation is left as a TODO so we don't fabricate a result.
 */

export const runtime = "edge";

// Palette (matches the report page surfaces).
const BG = "#09090b";
const SURFACE = "#18181b";
const TEXT = "#fafafa";
const MUTED = "#a1a1aa";
const FAINT = "#71717a";
const RED = "#dc2626";
const GREEN = "#22c55e";

// Exemplar failure summary. TODO: derive from the failing verdict's hint/output
// of a real run instead of this fixed string.
const FAILURE_SUMMARY =
  "Agent got stuck on webhook setup — docs reference registerEndpoint() but SDK exports webhooks.listen()";

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
  { params }: { params: { id: string } },
): Promise<ImageResponse> {
  const run: RunResult | null = getRun(params.id);
  if (!run) return notFoundCard();

  const { passed, total, ok } = summarize(run);
  const failed = total - passed;
  const badgeColor = ok ? GREEN : RED;
  const badgeLabel = ok ? "PASSED" : "FAILED";
  const duration = formatDuration(run.durationSec);
  const subtitle = `${passed}/${total} tests passed · Claude Code · ${duration}`;

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
        <div style={{ display: "flex", color: FAINT, fontSize: 28, letterSpacing: 1 }}>
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
                letterSpacing: 2,
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
            {FAILURE_SUMMARY}
          </div>
        </div>

        {/* Footer pass/fail row */}
        <div style={{ display: "flex", marginTop: 40, fontSize: 34, fontWeight: 600 }}>
          <div style={{ display: "flex", color: GREEN, marginRight: 48 }}>
            {`✓ ${passed} passed`}
          </div>
          <div style={{ display: "flex", color: RED }}>{`✗ ${failed} failed`}</div>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
