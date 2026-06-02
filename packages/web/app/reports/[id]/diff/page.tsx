import Link from "next/link";
import { getRun, listRunsForEval, type RunResult, type Verdict } from "@kiln/shared";

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

/** Compare a verdict against the same-named verdict in the previous run. */
function flip(prev: Verdict | undefined, cur: Verdict): Flip {
  if (!prev) return null;
  if (!prev.passed && cur.passed) return "fixed";
  if (prev.passed && !cur.passed) return "regressed";
  return null;
}

/** Align by assertion name (indices can shift across runs). */
function matchPrev(prev: RunResult, cur: Verdict): Verdict | undefined {
  return prev.verdicts.find((v) => v.name === cur.name) ?? prev.verdicts[cur.assertionIndex];
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
  const ok = passed === total && total > 0;
  return (
    <div className="diff-col">
      <div className="diff-col-header">
        <span className="diff-col-label">{label}</span>
        <span className="diff-col-date">{colDate(run.startedAt)}</span>
      </div>
      {run.verdicts.map((v) => {
        const f = prev ? flip(matchPrev(prev, v), v) : null;
        const rowClass = f === "fixed" ? "flipped" : v.passed ? "pass" : "fail";
        return (
          <div key={v.assertionIndex} className={`diff-verdict-row ${rowClass}`}>
            <span style={{ color: v.passed ? "var(--green)" : "var(--red)", fontSize: "14px" }}>
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
export default function DiffPage({ params }: { params: { id: string } }) {
  const current = getRun(params.id);
  const completed = current
    ? listRunsForEval(current.evalId).filter((r) => r.status === "completed")
    : [];

  if (completed.length < 2) {
    return (
      <div>
        <div className="diff-header">
          <h2>Run Comparison</h2>
          <p>{current?.evalTitle ?? "Eval"}</p>
        </div>
        <div className="platform-error" style={{ borderColor: "var(--border)" }}>
          <h3>Not enough runs to compare yet</h3>
          <p>
            A comparison needs at least two completed runs of the same eval. Re-run this eval
            after changing your docs or SDK, and the fixed/regressed tests will show up here.
          </p>
          <Link className="btn btn-primary" href="/evals/new">
            Re-run Eval →
          </Link>
        </div>
      </div>
    );
  }

  const previous = completed[completed.length - 2]!;
  const latest = completed[completed.length - 1]!;
  const fixedCount = latest.verdicts.filter((v) => flip(matchPrev(previous, v), v) === "fixed").length;
  const regressedCount = latest.verdicts.filter(
    (v) => flip(matchPrev(previous, v), v) === "regressed"
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
        {fixedCount > 0 && (
          <strong style={{ color: "var(--green)" }}>+{fixedCount} tests fixed</strong>
        )}
        {fixedCount > 0 && regressedCount > 0 && " · "}
        {regressedCount > 0 && (
          <strong style={{ color: "var(--red)" }}>{regressedCount} regressed</strong>
        )}
        {fixedCount === 0 && regressedCount === 0 && (
          <span>No tests changed between these two runs.</span>
        )}
      </div>
    </div>
  );
}
