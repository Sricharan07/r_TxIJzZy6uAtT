import type {
  Finding,
  OzAgentState,
  OzBehaviorSummary,
  OzEvidence,
  OzFrictionCategory,
  OzFrictionInsight,
  OzFrictionStatus,
  OzProductProfile,
  RunResult,
  Severity,
} from "@kiln/shared";

interface DraftInsight {
  key: string;
  category: OzFrictionCategory;
  title: string;
  severity: Severity;
  status: OzFrictionStatus;
  runId: string;
  confidence: number;
  behavior: string;
  recommendation: string;
  traceEvidence: OzEvidence[];
  docsEvidence: OzEvidence[];
}

const MAX_EVIDENCE = 3;

function clip(text: string, max = 420): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function runText(run: RunResult): string {
  return [
    run.task,
    run.errorType ?? "",
    ...run.events.map((event) => `${event.kind}: ${event.text} ${event.annotation ?? ""}`),
    ...run.verdicts.map((verdict) => `${verdict.name} ${verdict.output ?? ""} ${verdict.hint ?? ""}`),
    ...(run.gradeReport?.findings ?? []).map((finding) => `${finding.code} ${finding.title}`),
  ].join("\n");
}

function traceEvidence(run: RunResult, pattern: RegExp, fallback: string): OzEvidence[] {
  const evidence = run.events
    .filter((event) => pattern.test(`${event.text}\n${event.annotation ?? ""}`))
    .slice(0, MAX_EVIDENCE)
    .map((event) => ({
      source: `run:${run.id}`,
      quote: clip([event.text, event.annotation].filter(Boolean).join(" — ")),
      confidence: 0.9,
    }));
  if (evidence.length) return evidence;
  const verdict = run.verdicts.find((item) => pattern.test(`${item.name}\n${item.output ?? ""}\n${item.hint ?? ""}`));
  if (verdict) {
    return [{
      source: `run:${run.id}`,
      quote: clip([verdict.name, verdict.output, verdict.hint].filter(Boolean).join(" — ")),
      confidence: 0.86,
    }];
  }
  return [{ source: `run:${run.id}`, quote: fallback, confidence: 0.6 }];
}

function fallbackDocs(state: OzAgentState): OzEvidence[] {
  return [
    ...(state.productProfile?.evidence ?? []),
    ...state.discovery.selectedDocs.slice(0, 2).map((page) => ({
      source: page.url,
      quote: page.title || "Selected product documentation.",
      confidence: 0.62,
    })),
  ].slice(0, MAX_EVIDENCE);
}

function evidenceForCategory(state: OzAgentState, category: OzFrictionCategory): OzEvidence[] {
  const profile = state.productProfile;
  if (!profile) return fallbackDocs(state);
  const byCategory: Partial<Record<OzFrictionCategory, OzEvidence[]>> = {
    auth: profile.auth?.evidence,
    sdk: profile.sdks.flatMap((sdk) => sdk.evidence),
    api: profile.APIs.flatMap((api) => api.evidence),
    docs: [
      ...profile.evidence,
      ...state.discovery.selectedDocs.slice(0, 2).map((page) => ({
        source: page.url,
        quote: page.title || "Selected product documentation.",
        confidence: 0.65,
      })),
    ],
    environment: [
      ...profile.sdks.flatMap((sdk) => sdk.evidence),
      ...profile.evidence,
    ],
  };
  return (byCategory[category]?.length ? byCategory[category] : fallbackDocs(state)).slice(0, MAX_EVIDENCE);
}

function productPackageNames(profile: OzProductProfile | undefined): Set<string> {
  return new Set(profile?.sdks.map((sdk) => sdk.packageName) ?? []);
}

function unsupportedPackages(run: RunResult, profile: OzProductProfile | undefined): string[] {
  const allowed = productPackageNames(profile);
  const names = new Set<string>();
  const installPatterns = [
    /\b(?:npm\s+(?:install|i)|pnpm\s+add|yarn\s+add|bun\s+add)\s+(@?[a-z0-9._-]+(?:\/[a-z0-9._-]+)?)/gi,
    /\bpip(?:3)?\s+install\s+([a-z0-9._-]+)/gi,
  ];
  for (const event of run.events) {
    if (event.kind !== "command") continue;
    for (const pattern of installPatterns) {
      for (const match of event.text.matchAll(pattern)) {
        const name = match[1];
        if (name && allowed.size > 0 && !allowed.has(name)) names.add(name);
      }
    }
  }
  return [...names];
}

function repeatedErrorSignals(run: RunResult): number {
  const counts = new Map<string, number>();
  for (const event of run.events) {
    if (event.kind !== "fail" && event.kind !== "warn") continue;
    const key = clip((event.annotation ?? event.text).toLowerCase().replace(/\b\d+\b/g, "#"), 140);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

function apiErrorSignals(run: RunResult): number {
  return run.events.filter((event) =>
    /\b(?:400|401|403|404|409|422|429|5\d\d)\b|unauthorized|forbidden|bad request|unprocessable|rate limit/i.test(
      `${event.text}\n${event.annotation ?? ""}`,
    ),
  ).length;
}

function failedFinding(run: RunResult, code: string): Finding | undefined {
  return run.gradeReport?.findings.find((finding) => finding.code === code);
}

function hasFailedVerdict(run: RunResult, pattern: RegExp): boolean {
  return run.verdicts.some((verdict) => !verdict.passed && pattern.test(verdict.name));
}

function leakedSecretSignal(run: RunResult): boolean {
  if (hasFailedVerdict(run, /secret is not printed/i)) return true;
  return run.events.some((event) =>
    /\[redacted:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|BEARER|AUTH|CREDENTIAL)[A-Z0-9_]*\]/i.test(
      `${event.text}\n${event.annotation ?? ""}`,
    ),
  );
}

function runtimeSucceeded(run: RunResult, text: string): boolean {
  if (run.gradeReport?.taskPassed) return true;
  const projectCommandPassed = run.verdicts.some((verdict) => /project command succeeds/i.test(verdict.name) && verdict.passed);
  const resultContractPassed = run.verdicts.some((verdict) => /result (contract|artifact)/i.test(verdict.name) && verdict.passed);
  return run.status === "completed"
    && projectCommandPassed
    && resultContractPassed
    && /\bhttp\s*200\b|httpstatus["']?\s*[:=]\s*200|"ok"\s*:\s*true/i.test(text);
}

function insight(input: Omit<DraftInsight, "traceEvidence" | "docsEvidence"> & {
  traceEvidence?: OzEvidence[];
  docsEvidence?: OzEvidence[];
  state: OzAgentState;
}): DraftInsight {
  const { state: _state, traceEvidence: traces, docsEvidence: docs, ...rest } = input;
  return {
    ...rest,
    traceEvidence: (traces ?? []).slice(0, MAX_EVIDENCE),
    docsEvidence: (docs?.length ? docs : evidenceForCategory(input.state, input.category)).slice(0, MAX_EVIDENCE),
  };
}

function analyzeRun(state: OzAgentState, run: RunResult): DraftInsight[] {
  const text = runText(run);
  const lower = text.toLowerCase();
  const items: DraftInsight[] = [];
  const repeated = repeatedErrorSignals(run);
  const apiErrors = apiErrorSignals(run);

  if (run.errorType === "timeout" || /command timed out|run exceeded .* timeout/i.test(text)) {
    items.push(insight({
      key: "platform_timeout",
      category: "harness",
      title: "Run timed out before product behavior could be judged",
      severity: "high",
      status: "confirmed",
      runId: run.id,
      confidence: 0.95,
      behavior: "The run ended due to a timeout before Kiln could produce a reliable product signal.",
      recommendation: "Increase or propagate run timeouts and treat this run as inconclusive until the harness finishes reliably.",
      traceEvidence: traceEvidence(run, /timeout|timed out/i, "Run timed out."),
      state,
    }));
  }

  if (run.errorType === "platform" && /sandbox|firecracker|guest|ssh|manager unavailable|teardown/i.test(text)) {
    items.push(insight({
      key: "sandbox_failure",
      category: "harness",
      title: "Sandbox infrastructure interrupted the eval",
      severity: "high",
      status: "confirmed",
      runId: run.id,
      confidence: 0.93,
      behavior: "The agent did not reach a product integration result because the sandbox or transport layer failed.",
      recommendation: "Fix the Firecracker/runner failure before interpreting the run as product documentation feedback.",
      traceEvidence: traceEvidence(run, /sandbox|firecracker|guest|ssh|manager unavailable|teardown/i, "Sandbox failure."),
      state,
    }));
  }

  if (/missing required product environment variables/i.test(text)) {
    items.push(insight({
      key: "missing_required_env",
      category: "environment",
      title: "Required credentials were not available to the eval",
      severity: "high",
      status: "confirmed",
      runId: run.id,
      confidence: 0.96,
      behavior: "Kiln could not start a live product workflow because required product secrets were missing.",
      recommendation: "Collect every required credential in the run setup and make optional identifiers clearly optional.",
      traceEvidence: traceEvidence(run, /missing required product environment variables/i, "Required product env was missing."),
      state,
    }));
  }

  if (leakedSecretSignal(run) || /secret.*(?:printed|logged|exposed|leaked)|printed.*secret/i.test(lower)) {
    items.push(insight({
      key: "agent_secret_exposure",
      category: "agent",
      title: "Agent exposed credential values while debugging",
      severity: "high",
      status: "confirmed",
      runId: run.id,
      confidence: 0.94,
      behavior: "The agent inspected or wrote secret environment values instead of checking only whether variables were set.",
      recommendation: "Keep no-secret-printing instructions in the task and examples; docs should show presence checks rather than echoing credential values.",
      traceEvidence: traceEvidence(run, /\[redacted:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|BEARER|AUTH|CREDENTIAL)[A-Z0-9_]*\]|secret is not printed|secret.*(?:printed|logged|exposed|leaked)/i, "Secret guard failed."),
      state,
    }));
  }

  if (/glibc|native binding|optional dependencies|product (setup|preflight) step|cannot find native binding/i.test(text)) {
    items.push(insight({
      key: "native_runtime_requirement",
      category: "environment",
      title: "SDK setup depends on undocumented or unavailable native runtime support",
      severity: "high",
      status: "confirmed",
      runId: run.id,
      confidence: 0.92,
      behavior: "The agent failed before coding because package setup or import preflight hit a native/runtime dependency.",
      recommendation: "Document the SDK runtime matrix and native dependency requirements; configure Kiln to run this scenario on a compatible runtime image.",
      traceEvidence: traceEvidence(run, /glibc|native binding|optional dependencies|product (setup|preflight) step|cannot find native binding/i, "Native/runtime setup failed."),
      state,
    }));
  }

  if (/cannot find module|module not found|package not found|npm ERR! 404|pip.*no matching distribution/i.test(text)) {
    items.push(insight({
      key: "package_install_confusion",
      category: "sdk",
      title: "Agent could not install or resolve the documented package",
      severity: "high",
      status: "confirmed",
      runId: run.id,
      confidence: 0.86,
      behavior: "The trace shows package resolution failure before a working integration was produced.",
      recommendation: "Verify package names and installation commands in the quickstart, including package manager and version constraints.",
      traceEvidence: traceEvidence(run, /cannot find module|module not found|package not found|npm ERR! 404|pip.*no matching distribution/i, "Package resolution failed."),
      state,
    }));
  }

  if (/not a function|does not export|undefined method|is not exported|typeerror.*sdk/i.test(text)) {
    items.push(insight({
      key: "sdk_export_mismatch",
      category: "sdk",
      title: "SDK exports or examples did not match runtime behavior",
      severity: "high",
      status: "confirmed",
      runId: run.id,
      confidence: 0.88,
      behavior: "The agent reached SDK code but failed on exported symbols, methods, or initialization behavior.",
      recommendation: "Align SDK reference examples with the currently published package exports and include a minimal import/init snippet.",
      traceEvidence: traceEvidence(run, /not a function|does not export|undefined method|is not exported|typeerror.*sdk/i, "SDK runtime mismatch."),
      state,
    }));
  }

  if (/unauthorized|forbidden|\b401\b|\b403\b|invalid (api key|token|credential)|authentication failed|wrong auth/i.test(text)) {
    items.push(insight({
      key: "auth_confusion",
      category: "auth",
      title: "Agent could not apply the documented auth model",
      severity: "high",
      status: "confirmed",
      runId: run.id,
      confidence: 0.88,
      behavior: "The product rejected the request at the authentication layer or the grader detected a mismatched auth scheme.",
      recommendation: "Make credential names, auth headers, request body identifiers, and local test credential setup explicit in the quickstart.",
      traceEvidence: traceEvidence(run, /unauthorized|forbidden|\b401\b|\b403\b|invalid (api key|token|credential)|authentication failed|wrong auth/i, "Auth failure."),
      state,
    }));
  }

  if (/\b400\b|\b422\b|bad request|unprocessable|missing required field|invalid request body/i.test(text)) {
    items.push(insight({
      key: "request_shape_confusion",
      category: "api",
      title: "Agent could not infer the required API request shape",
      severity: "medium",
      status: runtimeSucceeded(run, text) ? "suspected" : "confirmed",
      runId: run.id,
      confidence: runtimeSucceeded(run, text) ? 0.67 : 0.84,
      behavior: "The trace contains request-shape errors, which usually means required fields, headers, or body examples were hard to infer.",
      recommendation: "Add a complete copy-pasteable request example with headers, body, success response, and common error response.",
      traceEvidence: traceEvidence(run, /\b400\b|\b422\b|bad request|unprocessable|missing required field|invalid request body/i, "Request shape error."),
      state,
    }));
  }

  if (failedFinding(run, "hallucinated_package") || failedFinding(run, "agent_hallucination")) {
    items.push(insight({
      key: "unsupported_agent_inference",
      category: "agent",
      title: "Agent invented an unsupported package or API surface",
      severity: "high",
      status: "confirmed",
      runId: run.id,
      confidence: 0.86,
      behavior: "The generated artifacts used a package or API surface that was not declared by the docs/context.",
      recommendation: "Keep unsupported-package checks enabled and add clearer package/install examples so agents stay on documented paths.",
      traceEvidence: traceEvidence(run, /hallucinated_package|agent_hallucination|imported package is not declared/i, "Unsupported package/API usage."),
      state,
    }));
  }

  const unsupported = unsupportedPackages(run, state.productProfile);
  if (unsupported.length) {
    items.push(insight({
      key: "unsupported_package_install",
      category: "agent",
      title: "Agent installed a package outside the discovered SDK set",
      severity: "medium",
      status: "suspected",
      runId: run.id,
      confidence: 0.72,
      behavior: `The trace includes package installs not discovered from docs: ${unsupported.join(", ")}.`,
      recommendation: "Prefer the documented SDK package list in the prompt and flag registry searches that leave the known product package set.",
      traceEvidence: traceEvidence(run, new RegExp(unsupported.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i"), "Unsupported package install."),
      state,
    }));
  }

  if (repeated >= 3) {
    items.push(insight({
      key: "agent_looped_on_same_error",
      category: "docs",
      title: "Agent looped on the same error",
      severity: "medium",
      status: "suspected",
      runId: run.id,
      confidence: 0.7,
      behavior: `The trace repeated the same fail/warn pattern ${repeated} times.`,
      recommendation: "Review the nearby docs for ambiguous setup, auth, or request-shape instructions and add a minimal known-good example.",
      traceEvidence: traceEvidence(run, /error|fail|warn|retry|again/i, "Repeated error loop."),
      state,
    }));
  }

  if (apiErrors >= 2 && runtimeSucceeded(run, text)) {
    items.push(insight({
      key: "success_after_api_errors",
      category: "api",
      title: "Agent succeeded only after API trial and error",
      severity: "medium",
      status: "suspected",
      runId: run.id,
      confidence: 0.66,
      behavior: `The run eventually succeeded, but it hit ${apiErrors} API error signals first.`,
      recommendation: "Make the first successful call example more complete so agents do not have to discover required fields by trial and error.",
      traceEvidence: traceEvidence(run, /\b(?:400|401|403|404|409|422|429|5\d\d)\b|bad request|unprocessable|rate limit/i, "API error before success."),
      state,
    }));
  }

  const surfaceAssertionMismatch = hasFailedVerdict(run, /documented product surface/i)
    || (run.gradeReport?.findings ?? []).some((finding) =>
      finding.status === "confirmed"
      && (finding.code === "documented_surface_not_referenced" || /documented product surface/i.test(finding.title))
    );
  if (runtimeSucceeded(run, text) && surfaceAssertionMismatch) {
    items.push(insight({
      key: "grader_surface_false_negative",
      category: "harness",
      title: "Harness assertion did not match the generated implementation",
      severity: "medium",
      status: "confirmed",
      runId: run.id,
      confidence: 0.78,
      behavior: "The runtime succeeded, but a product-surface assertion disagreed with the artifacts.",
      recommendation: "Refine generated assertions before using this signal as product documentation feedback.",
      traceEvidence: traceEvidence(run, /documented_surface_not_referenced|documented product surface/i, "Surface assertion mismatch."),
      state,
    }));
  }

  if (!items.length && runtimeSucceeded(run, text)) {
    items.push(insight({
      key: "no_friction_detected",
      category: "docs",
      title: "No meaningful doc friction detected in this run",
      severity: "low",
      status: "informational",
      runId: run.id,
      confidence: 0.74,
      behavior: "The agent reached a real successful product call without confirmed setup, auth, SDK, API, or harness friction.",
      recommendation: "Keep this scenario as a regression check and compare future runs for new retry, auth, or setup signals.",
      traceEvidence: traceEvidence(run, /\bhttp\s*200\b|success|ok/i, "Run succeeded."),
      state,
    }));
  }

  return items;
}

function aggregate(drafts: DraftInsight[]): OzFrictionInsight[] {
  const byKey = new Map<string, DraftInsight[]>();
  for (const draft of drafts) {
    byKey.set(draft.key, [...(byKey.get(draft.key) ?? []), draft]);
  }
  return [...byKey.entries()].map(([key, group]) => {
    const first = group[0]!;
    const affectedRunIds = [...new Set(group.map((item) => item.runId))];
    const status: OzFrictionStatus = affectedRunIds.length > 1 && first.status === "suspected" ? "confirmed" : first.status;
    const confidence = Math.min(0.99, Math.max(...group.map((item) => item.confidence)) + (affectedRunIds.length > 1 ? 0.1 : 0));
    return {
      id: `friction:${key}`,
      category: first.category,
      title: first.title,
      severity: first.severity,
      status,
      affectedRunIds,
      confidence,
      behavior: first.behavior,
      recommendation: first.recommendation,
      traceEvidence: group.flatMap((item) => item.traceEvidence).slice(0, MAX_EVIDENCE),
      docsEvidence: group.flatMap((item) => item.docsEvidence).slice(0, MAX_EVIDENCE),
    };
  }).sort((a, b) => {
    const severityOrder: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const severityDelta = severityOrder[a.severity] - severityOrder[b.severity];
    if (severityDelta !== 0) return severityDelta;
    if (a.status !== b.status) return a.status === "confirmed" ? -1 : b.status === "confirmed" ? 1 : 0;
    return b.confidence - a.confidence;
  });
}

export function behaviorSummaryFor(runs: RunResult[]): OzBehaviorSummary {
  return {
    totalRuns: runs.length,
    passedRuns: runs.filter((run) =>
      run.status === "completed"
      && (run.gradeReport ? run.gradeReport.taskPassed : run.verdicts.every((verdict) => verdict.type === "llm" || verdict.passed))
    ).length,
    failedRuns: runs.filter((run) => run.status === "errored" || (run.gradeReport && !run.gradeReport.taskPassed)).length,
    retrySignals: runs.reduce((sum, run) => sum + run.events.filter((event) => /\bretry|again|try another|rerun/i.test(event.text)).length, 0),
    apiErrorSignals: runs.reduce((sum, run) => sum + apiErrorSignals(run), 0),
    unsupportedSignals: runs.reduce((sum, run) => sum + unsupportedPackages(run, undefined).length, 0),
    secretExposureSignals: runs.reduce((sum, run) => sum + (leakedSecretSignal(run) ? 1 : 0), 0),
    platformSignals: runs.filter((run) => run.errorType !== null).length,
  };
}

export function analyzeFriction(state: OzAgentState, runs: RunResult[]): OzFrictionInsight[] {
  return aggregate(runs.filter((run) => run.status !== "canceled").flatMap((run) => analyzeRun(state, run)));
}
