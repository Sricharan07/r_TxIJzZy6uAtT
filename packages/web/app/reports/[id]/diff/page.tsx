import type { RunResult, Verdict } from "@kiln/shared";
import { getStore } from "@kiln/shared/store";

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
export default async function DiffPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const selected = await getStore().getRun(id);
  if (!selected) {
    return (
      <div className="diff-header">
        <h2>Run Comparison</h2>
        <p>Report not found.</p>
      </div>
    );
  }
  const runs = await getStore().listRuns(selected.evalId);
  const selectedIndex = runs.findIndex((r) => r.id === selected.id);
  const latest = runs[selectedIndex >= 0 ? selectedIndex : runs.length - 1] ?? selected;
  const previousCandidates = runs
    .slice(0, selectedIndex >= 0 ? selectedIndex : runs.length - 1)
    .filter((r) => r.verdicts.length > 0);
  const previous =
    previousCandidates.length > 0 ? previousCandidates[previousCandidates.length - 1] : undefined;
  if (!previous) {
    return (
      <div className="diff-header">
        <h2>Run Comparison</h2>
        <p>Run the eval at least twice to compare verdict changes.</p>
      </div>
    );
  }
  const fixedCount = latest.verdicts.filter(
    (v) => flip(previous.verdicts[v.assertionIndex], v) === "fixed"
  ).length;
  const regressedCount = latest.verdicts.filter(
    (v) => flip(previous.verdicts[v.assertionIndex], v) === "regressed"
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
        <strong style={{ color: "var(--green)" }}>+{fixedCount} tests fixed</strong>
        {regressedCount > 0 && (
          <>
            {" "}
            <strong style={{ color: "var(--red)" }}>-{regressedCount} regressed</strong>
          </>
        )}{" "}
        compared with the previous run
      </div>
    </div>
  );
}
