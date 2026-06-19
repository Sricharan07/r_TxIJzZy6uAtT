/**
 * Kiln shared types — the contract between web, runner, and grader.
 *
 * An eval is "task + context + assertions". The runner executes an agent in a
 * sandbox against that config and emits a stream of {@link AgentEvent}s; the
 * grader turns the agent's artifacts into {@link Verdict}s. The web app renders
 * the resulting {@link RunResult}.
 */

/** Supported agent runtimes the eval targets (Decision 4). */
export type Language = "node" | "python" | "go" | "other";

/** Pluggable agent adapters (Decision 3). */
export type AgentType = "claude-code" | "codex" | "cursor";

/** Where a piece of context comes from (Decision 15). */
export type ContextSourceType = "url" | "repo" | "file" | "paste";

/** Grading mode from the grading specification. Slice 1 implements integration-build. */
export type GradeMode = "integration-build" | "tool-use";

/** Build phase marker for the grading specification. */
export type BuildPhase = "slice-1" | "slice-2" | "later";

/** Task lane from the grading specification coverage matrix. */
export type TaskLane = "A" | "B" | "C" | "D" | "E" | "F" | "G";

/** Grader categories. */
export type GraderKind = "deterministic" | "static" | "dynamic" | "trace" | "judge";

/** Severity used for findings and grade caps. */
export type Severity = "critical" | "high" | "medium" | "low";

/** Finding lifecycle. Slice 1 treats LLM-judge findings as advisory. */
export type FindingStatus = "confirmed" | "unverified" | "advisory" | "dismissed";

/** Evidence source type shown in reports. */
export type EvidenceType = "deterministic" | "static" | "dynamic" | "trace" | "judge";

/** Whether evidence excerpts were redacted before storage/display. */
export type RedactionStatus = "clean" | "redacted";

/** Letter-grade bands from the grading specification. */
export type GradeBand =
  | "A+"
  | "A"
  | "A-"
  | "B+"
  | "B"
  | "B-"
  | "C+"
  | "C"
  | "C-"
  | "D"
  | "F";

export type CodeVsNoCode = "code" | "no-code" | "mixed";

/**
 * A single context input the agent will see. URLs and repos are re-fetchable on
 * re-runs so context stays fresh; files and pastes are stored verbatim.
 */
export interface ContextSource {
  type: ContextSourceType;
  /** Display label, e.g. the URL, repo path, or filename. */
  label: string;
  /** For `url`: how deep to crawl. `single` = just this page. */
  crawlDepth?: "single" | "linked";
  /** For `repo`: directories/globs to include. */
  paths?: string[];
  /** For `file`/`paste`: the literal content. */
  content?: string;
}

/** Product category used to generate sensible setup and assertion defaults. */
export type ProductType =
  | "sdk"
  | "api"
  | "cli"
  | "web-ui"
  | "auth"
  | "payments"
  | "storage"
  | "ai-sdk"
  | "rag"
  | "database"
  | "other";

/** Where a declared product secret may be exposed during an eval run. */
export type ProductEnvScope = "setup" | "agent" | "assertion" | "cleanup";

/** Runtime image requested by a product profile. */
export type ProductRuntimeImage =
  | "default"
  | "ubuntu-22.04-node22"
  | "ubuntu-24.04-node22"
  | "python"
  | "go";

export interface ProductRuntimeRequirement {
  language: Language;
  image?: ProductRuntimeImage;
  nodeVersion?: string;
  pythonVersion?: string;
  goVersion?: string;
}

export interface ProductEnvRequirement {
  /** Environment variable name. Values are never stored in eval configs. */
  name: string;
  scopes: ProductEnvScope[];
  required?: boolean;
  description?: string;
}

export type ProductSecretScopeType = "oz_job" | "eval";

export interface ProductSecretSummary {
  scopeType: ProductSecretScopeType;
  scopeId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type ProductPackageManager = "npm" | "pip" | "go" | "shell";

export interface ProductPackage {
  manager: ProductPackageManager;
  name: string;
  version?: string;
  installCommand?: string;
  importCheck?: string;
}

export interface ProductCommandStep {
  name: string;
  command: string;
  cwd?: string;
}

/** Reusable product/company setup embedded in an eval config. */
export interface ProductProfile {
  companyName: string;
  productName: string;
  productType: ProductType;
  runtime: ProductRuntimeRequirement;
  docsSources: ContextSource[];
  packages?: ProductPackage[];
  requiredEnv?: ProductEnvRequirement[];
  setupSteps?: ProductCommandStep[];
  preflightChecks?: ProductCommandStep[];
  cleanupSteps?: ProductCommandStep[];
}

/** Assertion kinds (Decisions 5 & 16). Shell/http/file are deterministic; llm is AI-judged. */
export type AssertionType = "shell" | "http" | "file" | "llm";

/** A single pass/fail test definition. The `config` shape depends on `type`. */
export interface Assertion {
  /** Stable grader id when imported from a richer TaskSpec. */
  id?: string;
  type: AssertionType;
  /** Human-readable name shown in the report verdicts. */
  name: string;
  config: ShellAssertion | HttpAssertion | FileAssertion | LlmAssertion;
  /** Defaults to true for deterministic assertions and false for LLM assertions. */
  required?: boolean;
  /** Optional grading metadata used when this assertion emits a finding. */
  severityOnFail?: Severity;
  frictionCode?: string;
  canHardCap?: boolean;
  hardCapGrade?: GradeBand;
  codeVsNoCode?: CodeVsNoCode;
}

export interface ShellAssertion {
  /** Command that must exit 0. */
  command: string;
  /** Optional working directory inside the sandbox. */
  cwd?: string;
}

export interface HttpAssertion {
  url: string;
  /** HTTP method (default GET). */
  method?: HttpMethod;
  /** Optional request headers. */
  headers?: Record<string, string>;
  /** Optional request body for non-GET assertions. */
  body?: string;
  /** Expected status code (default 200). */
  expectStatus?: number;
  /** Optional substring the response body must contain. */
  expectBodyContains?: string;
  /** Optional substring the response body must not contain. */
  expectBodyNotContains?: string;
}

export interface FileAssertion {
  path: string;
  /** When set, the file must contain this string (otherwise existence is enough). */
  contains?: string;
}

export interface LlmAssertion {
  /** Natural-language criterion, e.g. "Code follows SDK recommended patterns". */
  criterion: string;
}

export interface TaskOracle {
  quickstartRef?: string;
  referenceImplementationRef?: string;
  expectedEndState: Record<string, unknown>;
  replaySetupCmd?: string;
  replayAssertCmd?: string;
}

export interface GraderSpec {
  id: string;
  kind: GraderKind;
  name: string;
  required: boolean;
  severityOnFail: Severity;
  frictionCode?: string;
  replayCmdTemplate: string;
}

export interface TaskSpec {
  id: string;
  title: string;
  mode: GradeMode;
  lane: TaskLane;
  prompt: string;
  contextRefs: string[];
  agentTypes: AgentType[];
  modelIds: string[];
  n: number;
  weight: number;
  oracle: TaskOracle;
  requiredGraders: GraderSpec[];
  staticGraders: GraderSpec[];
  dynamicGraders: GraderSpec[];
  tags: string[];
}

export interface GraderEvidence {
  type: EvidenceType;
  confidence: number;
  replayCmd: string;
  redactionStatus: RedactionStatus;
  customerExcerpt: string;
  artifactRefs?: string[];
  observedAt: string;
}

export interface Finding {
  id: string;
  runId: string;
  taskSpecId: string;
  code: string;
  title: string;
  severity: Severity;
  status: FindingStatus;
  canHardCap: boolean;
  hardCapGrade?: GradeBand;
  evidence: GraderEvidence[];
  fixTemplateId?: string;
  codeVsNoCode: CodeVsNoCode;
}

export interface ConfidenceInterval {
  low: number;
  high: number;
}

export interface GradeCap {
  maxGrade: GradeBand;
  maxScore: number;
  reason: string;
  findingIds: string[];
}

export interface GradeScore {
  raw: number;
  capped: number;
  letter: GradeBand;
  passRate: number;
  confidenceInterval: ConfidenceInterval;
  runs: number;
  passedRuns: number;
  cap?: GradeCap;
}

export interface AgentModelGrade {
  agentType: AgentType;
  modelId: string;
  runs: number;
  passedRuns: number;
  passRate: number;
}

export interface RemediationProjection {
  score: number;
  letter: GradeBand;
  summary: string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface DynamicProbe {
  id?: string;
  name: string;
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  expectStatus?: number;
  expectStatusMin?: number;
  expectStatusMax?: number;
  expectBodyContains?: string;
  expectBodyNotContains?: string;
  codeOnFail?: string;
  severityOnFail?: Severity;
  canHardCap?: boolean;
  hardCapGrade?: GradeBand;
  /** A success probe independently verifies the agent's claimed product success. */
  verificationRole?: "success" | "negative";
}

export interface TraceMetrics {
  durationSec: number;
  totalSteps: number;
  tokens: number;
  retryCount: number;
  loopOnSameErrorCount: number;
  humanRescueCount: number;
  apiErrorCount: number;
  sdkDiscoveryEvents: number;
  handRolledIndicators: number;
}

export interface GradeRunGroup {
  evalId: string;
  runIds: string[];
  expectedRuns: number;
  completedRuns: number;
  platformErrorRuns: number;
  status: "partial" | "complete";
}

export interface GradeStability {
  stable: boolean;
  bandSpread: number;
  minGrade: GradeBand;
  maxGrade: GradeBand;
  note: string;
}

export interface GradeDefinitionCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

/** The full eval definition stored as JSONB (Decision 4). */
export interface EvalConfig {
  task: string;
  language: Language;
  /** Optional product profile for product-agnostic setup, env forwarding, and cleanup. */
  productProfile?: ProductProfile;
  context: ContextSource[];
  assertions: Assertion[];
  /** Optional dynamic negative/runtime probes. */
  dynamicProbes?: DynamicProbe[];
  /** Optional richer task definition. Existing evals can omit this and derive one. */
  taskSpec?: TaskSpec;
  metadata: {
    agentType: AgentType;
    /** Hard sandbox timeout in seconds. */
    timeoutSec: number;
    /** Agent model id when known; "unknown" is used in reports otherwise. */
    modelId?: string;
    /** Requested run count. Slice 1 execution still stores each run independently. */
    requestedRuns?: number;
    /** Optional job whose product secrets were copied into this eval. Values are stored separately. */
    productSecretSourceJobId?: string;
  };
}

/** A persisted eval (Decision 19 — every config has a shareable URL). */
export interface Eval {
  id: string;
  userId: string;
  config: EvalConfig;
  createdAt: string;
  /** Unguessable token used for the shareable config URL. */
  shareToken: string;
}

/** Lifecycle status of a run (Decision 11 / 18). */
export type RunStatus = "pending" | "running" | "completed" | "errored" | "canceled";

/** Distinguishes the user's API signal from our infra failures (Decision 18). */
export type ErrorType = null | "platform" | "timeout";

/** One step in the agent's execution trace (Decision 3 / 6 / 11). */
export interface AgentEvent {
  /** Seconds since run start. */
  t: number;
  kind: "info" | "command" | "file" | "api" | "warn" | "fail";
  text: string;
  /** Expanded failure explanation rendered inline in the timeline. */
  annotation?: string;
}

/** A single graded assertion outcome (Decision 5 / 6). */
export interface Verdict {
  assertionIndex: number;
  type: AssertionType;
  name: string;
  passed: boolean;
  /** Captured command/HTTP/file output or judge reasoning. */
  output?: string;
  /** Short "what to fix" hint shown on failures. */
  hint?: string;
  /** Replayable evidence for this verdict. */
  evidence?: GraderEvidence[];
}

export interface GradeReport {
  runId: string;
  taskSpecId: string;
  mode: GradeMode;
  buildPhase: BuildPhase;
  taskPassed: boolean;
  score: GradeScore;
  findings: Finding[];
  agentMatrix: AgentModelGrade[];
  traceMetrics?: TraceMetrics;
  runGroup?: GradeRunGroup;
  stability?: GradeStability;
  definitionOfDone: GradeDefinitionCheck[];
  generatedAt: string;
  remediationProjection?: RemediationProjection;
}

/** A complete run, server-rendered into the report page (Decisions 6, 7, 9). */
export interface RunResult {
  id: string;
  evalId: string;
  evalTitle: string;
  task: string;
  agentType: AgentType;
  status: RunStatus;
  errorType: ErrorType;
  startedAt: string;
  finishedAt: string | null;
  durationSec: number;
  totalSteps: number;
  tokens: number;
  events: AgentEvent[];
  verdicts: Verdict[];
  gradeReport?: GradeReport;
}

export type ServiceType = "runner";

export interface ServiceHeartbeat {
  serviceId: string;
  serviceType: ServiceType;
  status: "online";
  lastSeenAt: string;
  version?: string;
  queueName?: string;
  concurrency?: number;
  sandboxMode?: string;
  metadata?: Record<string, unknown>;
}

export type OzMode = "copilot" | "autopilot" | "manual";

export type OzJobStatus =
  | "created"
  | "discovering"
  | "profiling"
  | "mapping_docs"
  | "generating_suite"
  | "critiquing_suite"
  | "awaiting_approval"
  | "running"
  | "diagnosing"
  | "reporting"
  | "complete"
  | "blocked"
  | "failed"
  | "stopped";

export interface OzEvidence {
  source: string;
  quote: string;
  confidence: number;
}

export interface OzCrawledPage {
  url: string;
  title: string;
  text: string;
  links: string[];
  fetchedAt: string;
}

export interface OzDocsCandidate {
  url: string;
  label: string;
  reason: string;
  confidence: number;
}

export interface OzGitHubRepoCandidate {
  url: string;
  reason: string;
  confidence: number;
}

export interface OzPackageCandidate {
  manager: ProductPackageManager;
  name: string;
  version?: string;
  evidence: OzEvidence[];
  confidence: number;
}

export interface OzCodeExample {
  language: string;
  code: string;
  sourceUrl: string;
}

export type OzResearchSourceType = "docs" | "github" | "npm" | "pypi" | "package" | "sdk_types" | "package_probe";

export interface OzResearchClaim {
  id: string;
  kind: string;
  subject: string;
  value: string;
  sourceType: OzResearchSourceType;
  evidence: OzEvidence;
  confidence: number;
}

export interface OzClaimConflict {
  id: string;
  category: OzFrictionCategory;
  title: string;
  severity: Severity;
  status: OzFrictionStatus;
  claims: OzResearchClaim[];
  recommendation: string;
  confidence: number;
}

export interface OzResearchReport {
  claims: OzResearchClaim[];
  conflicts: OzClaimConflict[];
  checkedSources: string[];
  generatedAt: string;
}

export interface OzAuthProfile {
  scheme: "api_key" | "bearer" | "basic" | "oauth" | "unknown";
  headerName?: string;
  envVars: string[];
  evidence: OzEvidence[];
}

export interface OzSdkProfile {
  language: Language | "curl";
  packageName: string;
  manager: ProductPackageManager;
  installCommand?: string;
  importHint?: string;
  symbols?: string[];
  methods?: string[];
  evidence: OzEvidence[];
}

export interface OzApiSurface {
  name: string;
  method?: HttpMethod;
  path?: string;
  description: string;
  evidence: OzEvidence[];
}

export interface OzWebhookSurface {
  name: string;
  signatureHeader?: string;
  description: string;
  evidence: OzEvidence[];
}

export interface OzRisk {
  code: string;
  severity: Severity;
  message: string;
  evidence?: OzEvidence[];
}

export interface OzProductProfile {
  companyName: string;
  productName: string;
  productType: ProductType[];
  summary: string;
  auth?: OzAuthProfile;
  sdks: OzSdkProfile[];
  APIs: OzApiSurface[];
  webhooks: OzWebhookSurface[];
  requiredEnv: ProductEnvRequirement[];
  confidence: number;
  evidence: OzEvidence[];
}

export interface OzScenario {
  id: string;
  title: string;
  rationale: string;
  task: string;
  assertions: Assertion[];
  dynamicProbes: DynamicProbe[];
  requiredEnv: ProductEnvRequirement[];
  setupSteps: ProductCommandStep[];
  cleanupSteps: ProductCommandStep[];
  confidence: number;
  sources: OzEvidence[];
  risks: OzRisk[];
}

export interface OzSuiteDraft {
  scenarios: OzScenario[];
  globalSetup: ProductCommandStep[];
  globalEnv: ProductEnvRequirement[];
  assertions: Assertion[];
  dynamicProbes: DynamicProbe[];
  confidence: number;
  risks: OzRisk[];
}

export interface OzVerification {
  schemaValid: boolean;
  runnable: boolean;
  missingSecrets: string[];
  weakAssertions: string[];
  hallucinationRisks: string[];
  destructiveRisks: string[];
}

export interface OzRecommendedFix {
  title: string;
  detail: string;
  target: "docs" | "sdk" | "api" | "tests" | "environment" | "agent";
  evidence: OzEvidence[];
}

export type OzFrictionCategory = "docs" | "auth" | "sdk" | "api" | "environment" | "agent" | "harness";
export type OzFrictionStatus = "confirmed" | "suspected" | "informational";

export interface OzFrictionInsight {
  id: string;
  category: OzFrictionCategory;
  title: string;
  severity: Severity;
  status: OzFrictionStatus;
  affectedRunIds: string[];
  confidence: number;
  behavior: string;
  recommendation: string;
  traceEvidence: OzEvidence[];
  docsEvidence: OzEvidence[];
}

export interface OzBehaviorSummary {
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  retrySignals: number;
  apiErrorSignals: number;
  unsupportedSignals: number;
  secretExposureSignals: number;
  platformSignals: number;
}

export interface OzReport {
  summary: string;
  findings: Finding[];
  behaviorSummary: OzBehaviorSummary;
  frictionInsights: OzFrictionInsight[];
  recommendedFixes: OzRecommendedFix[];
}

export interface OzAgentState {
  jobId: string;
  userId: string;
  input: {
    productUrl: string;
    userGoal?: string;
    preferredLanguage?: Language | "curl";
    agentTargets?: AgentType[];
    mode: OzMode;
  };
  discovery: {
    homepage?: OzCrawledPage;
    docsCandidates: OzDocsCandidate[];
    selectedDocs: OzCrawledPage[];
    githubRepos: OzGitHubRepoCandidate[];
    packages: OzPackageCandidate[];
    codeExamples: OzCodeExample[];
  };
  research?: OzResearchReport;
  productProfile?: OzProductProfile;
  suiteDraft?: OzSuiteDraft;
  verification?: OzVerification;
  approval?: {
    status: "pending" | "approved" | "rejected" | "edited";
    userEdits?: unknown;
  };
  run?: {
    evalId?: string;
    runIds: string[];
    liveEvents?: AgentEvent[];
    observedEventCount?: number;
    result?: unknown;
  };
  report?: OzReport;
  error?: string;
  stoppedAt?: string;
}

export type OzEventKind =
  | "discovery.started"
  | "docs.found"
  | "package.found"
  | "profile.updated"
  | "scenario.generated"
  | "suite.critiqued"
  | "suite.ready"
  | "approval.updated"
  | "run.started"
  | "run.observation"
  | "finding.created"
  | "report.created"
  | "job.blocked"
  | "job.failed"
  | "job.stopped";

export interface OzEvent {
  id?: string;
  jobId: string;
  kind: OzEventKind;
  phase: OzJobStatus;
  message: string;
  dedupeKey?: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export interface OzJob {
  id: string;
  userId: string;
  inputUrl: string;
  mode: OzMode;
  status: OzJobStatus;
  state: OzAgentState;
  createdAt: string;
  updatedAt: string;
}

export interface OzArtifact {
  id: string;
  jobId: string;
  type: string;
  name: string;
  data?: unknown;
  blobUrl?: string;
  createdAt: string;
}

/** GitHub-authenticated user (Decision 8). */
export interface User {
  id: string;
  /** GitHub's numeric identity. Present for OAuth-backed users. */
  githubId?: number;
  login: string;
  avatarUrl: string;
  createdAt: string;
}

/** Derived pass/fail summary used across the report, OG card, and diff. */
export interface RunSummary {
  passed: number;
  total: number;
  /** A run "passes" only when every assertion passes and there was no platform error. */
  ok: boolean;
}

export function summarize(run: RunResult): RunSummary {
  const total = run.verdicts.length;
  const passed = run.verdicts.filter((v) => v.passed).length;
  const ok = run.gradeReport
    ? run.errorType === null && run.gradeReport.taskPassed
    : run.errorType === null && total > 0 && run.verdicts.every((verdict) => verdict.type === "llm" || verdict.passed);
  return { passed, total, ok };
}

/** mm:ss formatting for durations. */
export function formatDuration(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
