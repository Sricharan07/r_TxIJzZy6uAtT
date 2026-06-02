import { MOCK_RUN, MOCK_RUN_FIXED, type RunResult, type Verdict } from "@kiln/shared";

function colDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
}

type Flip = "fixed" | "regressed" | null;

function flip(prev: Verdict | undefined, cur: Verdict): Flip {
  if (!prev) return null;
  if (!prev.passed && cur.passed) return "fixed";
  if (prev.passed && !cur.passed) return "regressed";
  return null;
}

function VerdictColumn({
  label,
  run,
  prev,
}: {
  label: string;
  run: RunResult;
  prev?: RunResult;
}) {
  const passed = run.verdicts.filter((v) => v.passed).length;
  const total = run.verdicts.length;
  const ok = passed === total;
  return (
    <div className="diff-col">
      <div className="diff-col-header">
        <span className="diff-col-label">{label}</span>
        <span className="diff-col-date">{colDate(run.startedAt)}</span>
      </div>
      {run.verdicts.map((v) => {
        const f = prev ? flip(prev.verdicts[v.assertionIndex], v) : null;
        const rowClass = f === "fixed" ? "flipped" : v.passed ? "pass" : "fail";
        return (
          <div key={v.assertionIndex} className={`diff-verdict-row ${rowClass}`}>
            <span
              style={{ color: v.passed ? "var(--green)" : "var(--red)", fontSize: "14px" }}
            >
              {v.passed ? "✓" : "✗"}
            </span>
            {v.name}
            {f === "fixed" && <span className="flip-tag">FIXED</span>}
            {f === "regressed" && (
              <span className="flip-tag" style={{ color: "var(--red)", background: "var(--red-bg)" }}>
                REGRESSED
              </span>
            )}
          </div>
        );
      })}
      <div style={{ marginTop: "14px" }}>
        <span className={`badge ${ok ? "badge-pass" : "badge-fail"}`} style={{ fontSize: "10px" }}>
          {passed}/{total} PASSED
        </span>
      </div>
    </div>
  );
}

/** Side-by-side run comparison with FIXED/REGRESSED tags (Decision 17). */
export default function DiffPage() {
  const previous = MOCK_RUN;
  const latest = MOCK_RUN_FIXED;
  const fixedCount = latest.verdicts.filter(
    (v) => flip(previous.verdicts[v.assertionIndex], v) === "fixed"
  ).length;

  return (
    <div>
      <div className="diff-header">
        <h2>Run Comparison</h2>
        <p>{latest.evalTitle}</p>
      </div>
      <div className="diff-grid">
        <VerdictColumn label="Previous Run" run={previous} />
        <VerdictColumn label="Latest Run" run={latest} prev={previous} />
      </div>
      <div className="diff-footer">
        <strong style={{ color: "var(--green)" }}>+{fixedCount} tests fixed</strong> after
        updating webhook docs to reference{" "}
        <code>webhooks.listen()</code>
      </div>
    </div>
  );
}
