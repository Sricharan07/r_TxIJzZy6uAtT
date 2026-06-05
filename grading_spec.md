# Kiln Grading Specification

**Version:** 2.0  
**Status:** North-star grading architecture plus first implementation slice.  
**Scope:** Agent integration readiness for code-writing agents and tool-using
agents.

This document has two jobs:

1. Define the long-term grading architecture Kiln grades toward.
2. Define the first production build batch so implementation stays narrow,
   deterministic, replayable, and credible.

The north star is intentionally broad. The first implementation slice is
intentionally narrow. Do not widen runtime lanes until the Lane A grading core
is accurate enough to sell.

## Part A: North-Star Architecture

### 1. Core Principle

Kiln is deterministic-first.

An eval passes only when the produced integration is correct, not merely when it
compiles or when an LLM says it looks plausible. "Compiles but wrong" is a
failure. Every verdict must carry replayable evidence.

The LLM judge is never the primary authority. Until a calibration pipeline
exists, judge findings are advisory only. After calibration, a judge finding may
become binding only if all of the following are true:

- The judge has measured precision >= 0.9 on a held-out human-labeled set.
- The specific finding type is explicitly enabled for hard-cap use in admin.
- The report labels the finding as calibrated and shows its evidence.

The safe default is that hard caps come only from deterministic, static, or
dynamic graders.

### 2. Two Grading Modes

| Mode | Question | Applies to |
| --- | --- | --- |
| Mode 1: Integration-build | Can an agent write code that correctly integrates the product? | APIs, SDKs, CLIs, webhooks, frontend widgets, mobile SDKs, IaC, and similar executable surfaces |
| Mode 2: Tool-use | Can an agent use the product's own agent surface correctly? | MCP servers, agent toolkits, function-calling tool libraries |

A product with both an API and an MCP server is graded in both modes. It gets a
build grade, a tool-use grade, and optionally a blended headline grade.

### 3. Grader Stack

Layers are ordered by authority.

| # | Layer | Role | Authority |
| --- | --- | --- | --- |
| 1 | Deterministic | Exercise the result and inspect real outcomes, created objects, returned values, or end state | Primary; can confirm hard caps |
| 2 | Static analysis | AST, pattern, schema, query, dependency, or config checks on the produced artifact | Primary; can confirm hard caps |
| 3 | Dynamic tests | Negative, adversarial, malformed-input, retry, timeout, and security behavior tests | Primary; can confirm hard caps |
| 4 | Trace inspection | Facts from the agent run trace: tool use, loops, retries, error recovery, tokens, timing | Supporting; feeds metrics and attribution |
| 5 | LLM judge | Proposes soft findings and candidate compiles-but-wrong explanations | Advisory unless explicitly calibrated and enabled |

Layers 1 through 3 produce binding verdicts. Layer 4 supports metrics and
attribution. Layer 5 can propose, but it does not decide the grade in the first
implementation slice.

### 4. Hard-Cap Rule

A confirmed critical finding caps the overall grade at a ceiling regardless of
the raw score.

A finding is confirmed only when supported by deterministic, static, or dynamic
evidence. A future calibrated judge can confirm a finding only under the
calibration rules in section 1.

Hard-cap ceilings:

- One confirmed critical: maximum C-
- Two confirmed criticals: maximum D
- Leaked secret, double-charge, destructive tool without confirmation, or
  equivalent severe safety failure: F

The cap is a ceiling only. If the raw score is lower than the cap, the lower
grade stands.

### 5. Oracle And Baseline

Every `TaskSpec` must define "good" before agents are run. This prevents
customers from calling the task unfair after seeing the result.

Each task should reference as many of these as are available:

- Official quickstart path.
- Reference implementation.
- Expert expected solution.
- Deterministic oracle.

The report should surface the gap clearly:

```text
The documented quickstart succeeds. The agent following it did not.
```

### 6. Task-Level Pass Criteria

A run's task passes if all are true:

- All required deterministic graders pass.
- No confirmed critical finding exists.
- The run is not flagged compiles-but-wrong by binding evidence.

Otherwise the task fails.

Runs-but-wrong is a failure. Declared-success-on-error is a failure.

### 7. Stochasticity And Confidence

Never treat one run as a stable product grade.

Production-grade reports run each configured `(task x agent x model)` multiple
times. Default production `n = 3`. Raise `n` for high-variance tasks.

Development and fast QA may use `n = 1`, but the data model and report contract
must support multi-run grading from day one.

Reports include:

- Pass-rate distribution.
- Wilson confidence interval.
- High-variance flag.
- Number of runs in the footer.
- Agent/model matrix used.

### 8. Execution Lanes

| Lane | Runtime | Surfaces served | Build phase |
| --- | --- | --- | --- |
| A: Server | Linux Firecracker microVM | REST, GraphQL, gRPC, SOAP, server SDKs, CLIs, IaC, inbound-webhook signature checks, message-broker clients | Slice 1 for REST/server SDK/webhook verify; later for others |
| B: Browser | Headless Chromium inside Lane A | Frontend SDKs, embeds, widgets, hosted checkout, OAuth redirect and consent flows | Later |
| C: Mobile | Android emulator on KVM nodes; iOS on macOS runner fleet | Android SDKs, iOS SDKs, React Native, Flutter | Later |
| D: Realtime | Lane A plus controllable event source and stateful assertions | WebSocket, SSE, WebRTC | Later |
| E: Async/event-driven | Lane A plus broker and eventual-consistency polling | Kafka, RabbitMQ, MQTT, pub/sub | Later |
| F: Webhook delivery | Per-run inbound relay with public callback URL | True outbound webhooks from product servers | Later |
| G: Tool-use | Agent runtime pointed at product MCP/toolkit plus deterministic end-state checker | MCP servers, agent toolkits, function-calling tools | Slice 2 |

All lanes inherit:

- Per-run isolation.
- Secret injection with redaction.
- Egress allowlist.
- Multi-run support.
- Replayable evidence contract.

### 9. Mode 1 Protocol Grading

REST:

- Deterministic: call endpoint or integration code and inspect created/returned
  object.
- Static: correct base URL and version, auth scheme, no secret logged, required
  idempotency key, pagination where needed.
- Dynamic: 4xx/5xx handling, malformed input, timeout/retry behavior, no false
  success declaration.

GraphQL:

- Deterministic: execute query/mutation and check response shape/end state.
- Static: validate against SDL, correct variables, nullability handling, no
  unnecessary over-fetching.
- Dynamic: partial-data handling, GraphQL error field handling.

gRPC:

- Deterministic: compile proto, call stub, assert response.
- Static: correct service/method, deadline/timeout set, streaming used
  correctly.
- Dynamic: status-code handling.

SOAP:

- Deterministic: WSDL-driven call and assertion.
- Static: well-formed envelope and namespaces.
- Dynamic: fault handling.

Webhook verification:

- Static: signature verification call present.
- Dynamic: unsigned or forged payload is rejected.
- Deterministic: valid payload is accepted and handled.

True webhook delivery:

- Runtime: Lane F.
- Deterministic: register per-run relay URL, trigger real product event, assert
  receipt and correct handling.
- Dynamic: idempotency and retry tolerance.

WebSocket:

- Runtime: Lane D.
- Deterministic: connect, subscribe, assert events arrive in order.
- Static/trace: heartbeat, reconnect, and backpressure handling.
- Dynamic: server drop must reconnect.

SSE:

- Runtime: Lane D.
- Deterministic: stream consumed, events parsed.
- Static: `Last-Event-ID` reconnect handling.

WebRTC:

- Runtime: Lane D.
- Dynamic: signaling and ICE exchange complete.
- Trace: correct offer/answer flow.
- Verifiability is lower; grade connection establishment, not media quality.

Async queues:

- Runtime: Lane E.
- Deterministic: publish, consume, poll-with-timeout for end state.
- Static: ack/commit, at-least-once idempotency, dead-letter handling.

### 10. Mode 1 SDK And Surface Handling

Server SDK:

- Runtime: Lane A with correct language toolchain.
- Static graders are language-aware.
- Common findings: `sdk_not_discovered`, `hallucinated_package`,
  `wrong_entry_point`, `wrong_init`.

Frontend SDK, embeds, widgets:

- Runtime: Lane B.
- Deterministic: DOM/visual/network assertions.
- Critical findings: `secret_in_client`, wrong init order, CSP failure, iframe
  failure.

Mobile Android:

- Runtime: Lane C.
- Build APK with Gradle, install on emulator, drive UI, inspect server-side
  object.
- Static: manifest permissions, no secret in APK, min/target SDK.

Mobile iOS:

- Runtime: Lane C on macOS fleet.
- Build with Xcode, run on Simulator, drive UI.
- Static: `Info.plist`, entitlements, keychain usage, no secret in bundle.

React Native / Flutter:

- Runtime: Lane C.
- Build and run both target platforms when relevant.

CLI:

- Runtime: Lane A.
- Deterministic: exit codes and artifact inspection.
- Static: correct subcommands and flags.

IaC / Terraform:

- Runtime: Lane A against a test cloud account.
- Deterministic: `plan`, `apply`, inspect resource, `destroy`.
- Budget-bounded because it is slower and can create cost.

### 11. Documentation-Type Handling

Docs are graded through agent success, not as prose quality.

Reference docs:

- Signal: parameter, endpoint, auth, schema correctness in produced code.
- Findings: `stale_endpoint`, `wrong_auth_scheme`, `param_mismatch`.

Quickstart/tutorial:

- Signal: time-to-first-success and first-try-correct on documented path.
- Findings: `quickstart_path_broken`, `missing_example`.

How-to guide:

- Signal: scenario task completion.
- Finding: `howto_gap`.

Explanation/conceptual docs:

- Signal: attribution only.
- Finding: `concept_not_surfaced`.
- Advisory unless the missing concept maps to a deterministic failure.

Migration/changelog:

- Task type: upgrade from version N to N+1.
- Deterministic: upgraded integration still passes.
- Static: no deprecated calls remain.
- Findings: `migration_path_broken`, `deprecated_usage`.

### 12. Mode 2 Tool-Use Grading

The agent is not writing integration code. It is given the product's MCP server
or toolkit plus a task and is graded on whether it drives tools correctly.

Golden prompt types:

- Direct: "Create a customer named X."
- Indirect: "I need to bill this person monthly."
- Negative: "Delete all production data."

Graders:

- Tool-selection accuracy: did the agent pick the correct tool or tools?
- Argument validity: are arguments well-formed and semantically correct against
  the tool schema?
- End-state correctness: did the tool calls produce the correct product state?
- Confirmation-flow correctness: destructive/irreversible tools require
  confirmation.
- Negative-prompt handling: refuse dangerous/out-of-scope requests and do not
  invent nonexistent tools.
- Tool-error recovery: recover from tool errors without looping or quitting
  incorrectly.
- Efficiency: turns/tokens to completion.

Tool-surface findings:

- `wrong_tool_selected`
- `bad_tool_args`
- `tool_hallucination`
- `unsafe_tool_no_confirmation`
- `ambiguous_tool_description`
- `missing_tool`
- `over_broad_tool`
- `bad_tool_args_schema`

### 13. Metrics

Mode 1 and shared metrics:

- Task success rate.
- First-try-correct rate.
- Compiles-but-wrong rate.
- Time-to-working-integration.
- Iterations-to-success.
- Recovery rate.
- Tokens-to-success.
- SDK/MCP discoverability.
- Human rescues.
- Internal-baseline delta.

Mode 2 metrics:

- Tool-selection accuracy.
- Argument-validity rate.
- End-state task-completion rate.
- Confirmation-correctness rate.
- Negative-prompt-pass rate.
- Tool-error-recovery rate.
- Turns/tokens to completion.

### 14. Severity Levels

| Severity | Meaning | Can hard-cap? |
| --- | --- | --- |
| Critical | Silent security/correctness failure that would ship | Yes, when confirmed |
| High | Functional failure that blocks or seriously degrades the integration | No, but heavy weight |
| Medium | Friction that slows the agent but does not fully break the integration | No |
| Low | Cosmetic or suboptimal-but-working issue | No |

Critical examples:

- Missing signature verification.
- Secret leaked in code, logs, client bundle, or app bundle.
- No PKCE where required.
- Non-idempotent double charge.
- Hallucinated package.
- Destructive tool call without confirmation.
- Tool hallucination on a dangerous request.

### 15. Friction Taxonomy

Discovery:

- `sdk_not_discovered`
- `hallucinated_package`
- `wrong_entry_point`

Auth:

- `wrong_auth_scheme`
- `no_pkce`
- `token_in_localstorage`
- `secret_in_client`
- `secret_in_app_bundle`
- `missing_token_refresh`
- `bad_scopes`

Security/correctness:

- `missing_signature_verification`
- `no_idempotency`
- `secret_in_logs`
- `input_not_validated`

Resilience:

- `no_retry`
- `no_rate_limit_backoff`
- `no_pagination`
- `no_reconnect`
- `no_ack`
- `no_dead_letter`
- `poor_error_handling`
- `false_success_declaration`

Protocol-specific:

- `invalid_graphql_query`
- `graphql_over_fetch`
- `grpc_no_deadline`
- `event_order_violation`
- `at_least_once_not_idempotent`

Mobile:

- `manifest_permission_misuse`
- `build_failure`
- `wrong_min_sdk`
- `missing_entitlement`

Tool-use:

- `wrong_tool_selected`
- `bad_tool_args`
- `tool_hallucination`
- `unsafe_tool_no_confirmation`
- `ambiguous_tool_description`
- `missing_tool`
- `over_broad_tool`

Docs:

- `stale_endpoint`
- `param_mismatch`
- `missing_example`
- `quickstart_path_broken`
- `howto_gap`
- `concept_not_surfaced`
- `deprecated_usage`
- `migration_path_broken`
- `ambiguous_error_message`

Every code maps to:

- Fix template.
- Code-vs-no-code flag.
- Evidence requirements.
- Default severity.

### 16. Grade Computation

Task score:

- Pass-rate = mean pass across n runs for the configured agent/model matrix.
- Include Wilson confidence interval.

Raw mode score:

- Weighted mean of task pass-rates.
- Suggested default weights:
  - Security tasks: x2.
  - First-success tasks: x3.
  - Default tasks: x1.

Hard caps:

- One confirmed critical: maximum C-.
- Two confirmed criticals: maximum D.
- Leaked secret, double-charge, or destructive tool without confirmation: F.

Bands:

| Grade | Score |
| --- | --- |
| A+ | >= 97 |
| A | 93-96 |
| A- | 90-92 |
| B+ | 87-89 |
| B | 83-86 |
| B- | 80-82 |
| C+ | 77-79 |
| C | 73-76 |
| C- | 70-72 |
| D | 60-69 |
| F | < 60 |

Products with both modes can receive a blended headline grade. Default blend is
50/50 unless product configuration says one surface matters more.

### 17. Evidence Contract

Every finding and verdict must have evidence.

`GraderEvidence`:

```ts
type EvidenceType = "deterministic" | "static" | "dynamic" | "trace" | "judge";
type RedactionStatus = "clean" | "redacted";

interface GraderEvidence {
  type: EvidenceType;
  confidence: number;
  replayCmd: string;
  redactionStatus: RedactionStatus;
  customerExcerpt: string;
  artifactRefs?: string[];
  observedAt: string;
}
```

Judge evidence is advisory unless confirmed by the rules above. Nothing in the
report should be unfalsifiable.

### 18. Coverage Matrix

| Surface | Lane | Primary graders | Verifiability | Critical to catch | Build phase |
| --- | --- | --- | --- | --- | --- |
| REST API | A | deterministic + static + dynamic | High | wrong auth, no idempotency | Slice 1 |
| Server SDK | A | deterministic + static | High | SDK not discovered, hallucinated package | Slice 1 |
| Webhook verification | A | static + dynamic | High | missing signature verification | Slice 1 |
| Auth static parts | A | static + deterministic | High | no PKCE, token leak | Slice 1 |
| Reference/quickstart/how-to docs | via task success | task graders | Varies | stale, missing example, broken quickstart | Slice 1 |
| Explanation docs | attribution | trace + advisory | Varies | concept not surfaced | Slice 1 |
| MCP/toolkit | G | tool selection + args + end state | High | tool hallucination, unsafe no-confirmation | Slice 2 |
| Migration/changelog | A | deterministic + static | High | deprecated usage, broken upgrade | Later |
| CLI | A | deterministic | High | wrong flags | Later |
| GraphQL | A | deterministic + SDL static | High | invalid query, over-fetch | Later |
| gRPC | A | deterministic + proto static | Medium-high | no deadline, wrong method | Later |
| SOAP | A | deterministic + WSDL static | Medium | malformed envelope | Later |
| True webhook delivery | F | deterministic + dynamic | High | not received, no retry/idempotency | Later |
| Browser auth/frontend | B | DOM/network + dynamic | Medium-high | consent failure, secret in client | Later |
| WebSocket/SSE | D | stateful deterministic + trace | Medium | no reconnect, event order | Later |
| WebRTC | D | dynamic + trace | Low-medium | signaling/ICE failure | Later |
| MQ/MQTT/Kafka | E | eventual deterministic | Medium | no ack, not idempotent | Later |
| Mobile Android/iOS | C | UI deterministic + static | Medium | secret in app, build failure | Later |
| IaC/Terraform | A | inspect provisioned resource | Medium | wrong resource, drift | Later |

### 19. Worked Examples

REST auth:

- Five tasks, two agents, n = 3: 30 runs.
- Task success rate: 41%.
- Raw score: 42, grade D.
- Confirmed critical findings: `no_pkce`, `missing_signature_verification`.
- Cap: D, already lower by raw score.
- Report highlights first-try-correct, compiles-but-wrong rate, and projected
  remediation.

MCP refund task:

- Tool selection: 78%.
- Argument validity: 91%.
- End-state correctness: 64%.
- Critical: `unsafe_tool_no_confirmation` on a destructive tool, confirmed by
  dynamic negative prompt.
- Cap: C-.
- Fix: rewrite ambiguous tool descriptions and add confirmation gate.

Android SDK task:

- Build sample app, install APK, drive login UI, inspect issued session.
- Critical: `secret_in_app_bundle`, confirmed static.
- Cap: C-.
- High: `manifest_permission_misuse`.

## Part B: First Implementation Slice

### 20. Guiding Rule

Breadth is the enemy.

Build the deterministic/evidence/severity core and scoring model on one lane
before widening. A sharp, replayable teardown on REST + SDK + webhook
verification is worth more than shallow protocol coverage.

### 21. Slice 1 Scope

Runtime:

- Lane A only: Linux Firecracker microVM.

Surfaces:

- REST API.
- Server SDK integration.
- Webhook signature verification.
- Auth static checks.
- Docs through task success.

Launch toolchains:

- Node/TypeScript.
- Python.

Explicitly deferred:

- GraphQL.
- gRPC.
- SOAP.
- Browser/front-end lane.
- Mobile.
- Realtime.
- Async brokers.
- True webhook delivery.
- IaC.
- Judge calibration.
- Full MCP prompt suites.

### 22. First Schema To Add

The evidence schema should land before the grade UI. Everything else hangs off
it.

Suggested domain objects:

```ts
type GradeMode = "integration-build" | "tool-use";
type BuildPhase = "slice-1" | "slice-2" | "later";
type GraderKind = "deterministic" | "static" | "dynamic" | "trace" | "judge";
type Severity = "critical" | "high" | "medium" | "low";
type FindingStatus = "confirmed" | "advisory" | "dismissed";

interface TaskSpec {
  id: string;
  title: string;
  mode: GradeMode;
  lane: "A" | "B" | "C" | "D" | "E" | "F" | "G";
  prompt: string;
  contextRefs: string[];
  agentTypes: string[];
  modelIds: string[];
  n: number;
  weight: number;
  oracle: TaskOracle;
  requiredGraders: GraderSpec[];
  staticGraders: GraderSpec[];
  dynamicGraders: GraderSpec[];
  tags: string[];
}

interface TaskOracle {
  quickstartRef?: string;
  referenceImplementationRef?: string;
  expectedEndState: Record<string, unknown>;
  replaySetupCmd?: string;
  replayAssertCmd?: string;
}

interface GraderSpec {
  id: string;
  kind: GraderKind;
  name: string;
  required: boolean;
  severityOnFail: Severity;
  frictionCode?: string;
  replayCmdTemplate: string;
}

interface Finding {
  id: string;
  runId: string;
  taskSpecId: string;
  code: string;
  title: string;
  severity: Severity;
  status: FindingStatus;
  canHardCap: boolean;
  hardCapGrade?: string;
  evidence: GraderEvidence[];
  fixTemplateId?: string;
  codeVsNoCode: "code" | "no-code" | "mixed";
}
```

### 23. Slice 1 Graders

Deterministic graders:

- Run the agent-produced integration.
- Inspect real output or created object.
- Compare to `TaskOracle.expectedEndState`.
- Emit replay command and captured output.

Static graders:

- AST or pattern checks on final generated artifact.
- Correct base URL/version.
- Correct auth scheme.
- No hard-coded secret.
- No secret in logs.
- Signature verification call present when required.
- Idempotency key used where required.
- Pagination handled where required.
- SDK imported vs hallucinated or hand-rolled package.

Dynamic graders:

- Send malformed input.
- Send forged/unsigned webhook payload.
- Force 4xx/5xx path.
- Assert the code does not declare success on failure.
- Assert useful error handling rather than silent failure.

Trace graders:

- SDK discovered vs hand-rolled.
- Loop-on-same-error count.
- Tool/API retries.
- Human rescue count.
- Time and token metrics.

LLM judge:

- Advisory only in Slice 1.
- Can propose compiles-but-wrong candidates.
- Cannot cap or decide pass/fail.

### 24. Grade Computation In Slice 1

Build multi-run support immediately:

- `n = 1` allowed for developer/test runs.
- `n = 3` default for production reports.
- Store every run independently.
- Compute pass-rate and Wilson CI from stored runs.

Grade computation order:

1. Compute task pass/fail per run.
2. Compute task pass-rate across n.
3. Compute weighted raw mode score.
4. Apply confirmed critical caps.
5. Convert to letter grade.
6. Render sub-metrics and evidence.

### 25. Report Requirements

The report must show:

- Headline letter grade.
- Raw score and any cap applied.
- Pass-rate plus confidence interval.
- Number of runs.
- Agent/model matrix.
- Findings ordered by severity.
- Replay command for each finding.
- Redacted customer excerpts.
- Evidence type and confidence.
- Before/after remediation projection when available.

The report should make the failure concrete enough that a domain expert agrees
with it and a customer knows what to fix.

### 26. Build Order

Dependency order, not calendar phases:

1. `TaskSpec` schema.
2. `Finding` and `GraderEvidence` schema.
3. Grader result normalization.
4. Deterministic grader runner.
5. Static grader plugins.
6. Dynamic negative tests.
7. Grade computation.
8. Report UI for evidence and caps.
9. Multi-run orchestration and Wilson CI.
10. Stability tuning.
11. Slice 1 definition-of-done gate.
12. Slice 2 MCP/tool-use mode.
13. Later lanes by demand.

### 27. Slice 1 Definition Of Done

Do not widen lanes until all are true:

- Every verdict is replayable from `replayCmd`.
- Grades are stable across reruns within one band, or variance is clearly
  flagged.
- Compiles-but-wrong is caught by deterministic/static/dynamic graders, not by
  the judge.
- Evidence is redacted and safe to share.
- The report is sharp enough to sell.
- Internal baseline A/B works: with/without `llms.txt`, current docs vs proposed
  fix, or old quickstart vs improved quickstart.

### 28. Slice 2: MCP Tool-Use

Add Mode 2 after the Lane A core is excellent.

Minimal first cut:

- Tool selection.
- Argument validity.
- End-state correctness.
- Unsafe-tool confirmation.
- Direct prompt set.
- Small negative prompt set.

Defer:

- Comprehensive indirect prompts.
- Large negative-prompt suites.
- Deep tool-error recovery benchmarks.

### 29. Later Build Triggers

| Deferred item | Trigger |
| --- | --- |
| GraphQL/gRPC/SOAP | Launch customer uses it |
| Browser lane | Frontend SDK, widget, hosted checkout, or browser auth customer |
| Mobile | Mobile SDK customer with budget |
| Realtime | Realtime-product customer |
| Async brokers | Event-driven product customer |
| True webhook delivery | Signature verification is not enough for a deal |
| IaC/Terraform | Infra-provider customer |
| Judge calibration | Labeled data exists and a judge-only finding needs binding authority |
| Comprehensive MCP suites | Minimal tool-use grading proves demand |

## Part C: Current Kiln Implementation Notes

Current production deployment already has:

- Firecracker Lane A execution.
- Claude Code, Codex, and Cursor adapters.
- Real Claude Code via Bedrock for the Claude adapter.
- Postgres-backed run metadata on the deployed VM.
- S3 trace persistence.
- Redis/BullMQ queueing.
- Public report URLs and GitHub OAuth.

Nearest implementation gap:

- The current assertion model is too simple for this spec. It needs to evolve
  from `assertions` into `TaskSpec`, `GraderSpec`, `Finding`, and
  `GraderEvidence`.

Recommended next PR:

1. Add shared types for `TaskSpec`, `Finding`, `GraderEvidence`, grade bands,
   severity, and friction codes.
2. Add database tables for task specs, findings, evidence, and grade summaries.
3. Add a small deterministic REST grader and one static secret-leak grader.
4. Update the report page to show findings and replay evidence.
