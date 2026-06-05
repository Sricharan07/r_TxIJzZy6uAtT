import type {
  AgentModelGrade,
  Finding,
  GradeBand,
  GradeCap,
  GradeDefinitionCheck,
  GradeReport,
  GradeRunGroup,
  GradeScore,
  GradeStability,
  RunResult,
} from "./types.js";

const GRADE_MAX_SCORE: Record<GradeBand, number> = {
  "A+": 100,
  A: 96,
  "A-": 92,
  "B+": 89,
  B: 86,
  "B-": 82,
  "C+": 79,
  C: 76,
  "C-": 72,
  D: 69,
  F: 0,
};

const GRADE_RANK: Record<GradeBand, number> = {
  "A+": 0,
  A: 1,
  "A-": 2,
  "B+": 3,
  B: 4,
  "B-": 5,
  "C+": 6,
  C: 7,
  "C-": 8,
  D: 9,
  F: 10,
};

export function gradeBandForScore(score: number): GradeBand {
  if (score >= 97) return "A+";
  if (score >= 93) return "A";
  if (score >= 90) return "A-";
  if (score >= 87) return "B+";
  if (score >= 83) return "B";
  if (score >= 80) return "B-";
  if (score >= 77) return "C+";
  if (score >= 73) return "C";
  if (score >= 70) return "C-";
  if (score >= 60) return "D";
  return "F";
}

export function gradeBandRank(grade: GradeBand): number {
  return GRADE_RANK[grade];
}

export function wilsonInterval(passed: number, total: number): { low: number; high: number } {
  if (total <= 0) return { low: 0, high: 0 };
  const z = 1.96;
  const phat = passed / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = phat + z2 / (2 * total);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total);
  return {
    low: Math.max(0, (center - margin) / denominator),
    high: Math.min(1, (center + margin) / denominator),
  };
}

export function computeGradeCap(findings: Finding[]): GradeCap | undefined {
  const confirmedCritical = findings.filter(
    (finding) =>
      finding.status === "confirmed" && finding.severity === "critical" && finding.canHardCap,
  );
  if (confirmedCritical.length === 0) return undefined;
  if (confirmedCritical.length >= 2) {
    return {
      maxGrade: "D",
      maxScore: GRADE_MAX_SCORE.D,
      reason: `${confirmedCritical.length} confirmed critical findings`,
      findingIds: confirmedCritical.map((finding) => finding.id),
    };
  }
  const first = confirmedCritical[0]!;
  const maxGrade = first.hardCapGrade ?? "C-";
  return {
    maxGrade,
    maxScore: GRADE_MAX_SCORE[maxGrade],
    reason: "1 confirmed critical finding",
    findingIds: [first.id],
  };
}

export function computeGradeScore({
  passedRuns,
  runs,
  findings,
}: {
  passedRuns: number;
  runs: number;
  findings: Finding[];
}): GradeScore {
  const passRate = runs > 0 ? passedRuns / runs : 0;
  const raw = passRate * 100;
  const cap = computeGradeCap(findings);
  const capped = cap ? Math.min(raw, cap.maxScore) : raw;
  return {
    raw,
    capped,
    letter: gradeBandForScore(capped),
    passRate,
    confidenceInterval: wilsonInterval(passedRuns, runs),
    runs,
    passedRuns,
    cap,
  };
}

function agentMatrixFor(runs: RunResult[]): AgentModelGrade[] {
  const rows = new Map<string, AgentModelGrade>();
  for (const run of runs) {
    const modelId = run.gradeReport?.agentMatrix[0]?.modelId ?? "unknown";
    const key = `${run.agentType}:${modelId}`;
    const current =
      rows.get(key) ??
      {
        agentType: run.agentType,
        modelId,
        runs: 0,
        passedRuns: 0,
        passRate: 0,
      };
    current.runs += 1;
    if (run.gradeReport?.taskPassed) current.passedRuns += 1;
    current.passRate = current.runs > 0 ? current.passedRuns / current.runs : 0;
    rows.set(key, current);
  }
  return [...rows.values()];
}

function stabilityFor(reports: GradeReport[]): GradeStability {
  const ranks = reports.map((report) => gradeBandRank(report.score.letter));
  const minRank = Math.min(...ranks);
  const maxRank = Math.max(...ranks);
  const minGrade = reports.find((report) => gradeBandRank(report.score.letter) === minRank)!.score.letter;
  const maxGrade = reports.find((report) => gradeBandRank(report.score.letter) === maxRank)!.score.letter;
  const bandSpread = maxRank - minRank;
  return {
    stable: bandSpread <= 1,
    bandSpread,
    minGrade,
    maxGrade,
    note:
      bandSpread <= 1
        ? "Observed reruns are stable within one grade band."
        : `Observed reruns vary from ${minGrade} to ${maxGrade}; variance is flagged.`,
  };
}

export function definitionChecksFor(report: GradeReport): GradeDefinitionCheck[] {
  const verdictEvidenceOk = report.findings.every((finding) =>
    finding.evidence.every((evidence) => evidence.replayCmd.trim().length > 0),
  );
  const redactionOk = report.findings.every((finding) =>
    finding.evidence.every(
      (evidence) => evidence.redactionStatus === "clean" || evidence.redactionStatus === "redacted",
    ),
  );
  const judgeOk = report.findings
    .filter((finding) => finding.evidence.some((evidence) => evidence.type === "judge"))
    .every((finding) => finding.status === "advisory" && !finding.canHardCap);
  const stabilityOk = report.stability?.stable ?? true;

  return [
    {
      id: "replayable-evidence",
      label: "Replayable evidence",
      passed: verdictEvidenceOk,
      detail: verdictEvidenceOk
        ? "Every finding has a replay command."
        : "One or more findings are missing replay commands.",
    },
    {
      id: "redaction",
      label: "Safe excerpts",
      passed: redactionOk,
      detail: redactionOk
        ? "Evidence excerpts carry an explicit redaction status."
        : "One or more evidence excerpts lack redaction status.",
    },
    {
      id: "judge-advisory",
      label: "Judge advisory only",
      passed: judgeOk,
      detail: judgeOk
        ? "Judge findings cannot hard-cap or decide pass/fail."
        : "A judge finding has binding authority.",
    },
    {
      id: "stability",
      label: "Rerun stability",
      passed: stabilityOk,
      detail: report.stability?.note ?? "Only one completed run is available.",
    },
  ];
}

export function aggregateCompletedRunReports(
  runs: RunResult[],
  expectedRuns: number,
): RunResult[] {
  const eligible = runs
    .filter((run) => run.status === "completed" && run.errorType === null && run.gradeReport)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  if (eligible.length === 0) return runs;

  const group = eligible.slice(-expectedRuns);
  const reports = group.map((run) => run.gradeReport!);
  const findings = reports.flatMap((report) => report.findings);
  const passedRuns = reports.filter((report) => report.taskPassed).length;
  const score = computeGradeScore({ passedRuns, runs: reports.length, findings });
  const runIds = new Set(group.map((run) => run.id));
  const runGroup: GradeRunGroup = {
    evalId: group[0]!.evalId,
    runIds: [...runIds],
    expectedRuns,
    completedRuns: reports.length,
    platformErrorRuns: runs.filter((run) => run.errorType !== null).length,
    status: reports.length >= expectedRuns ? "complete" : "partial",
  };
  const stability = reports.length > 1 ? stabilityFor(reports) : undefined;
  const agentMatrix = agentMatrixFor(group);

  return runs.map((run) => {
    if (!runIds.has(run.id) || !run.gradeReport) return run;
    const gradeReport: GradeReport = {
      ...run.gradeReport,
      score,
      agentMatrix,
      runGroup,
      stability,
    };
    return {
      ...run,
      gradeReport: {
        ...gradeReport,
        definitionOfDone: definitionChecksFor(gradeReport),
      },
    };
  });
}
