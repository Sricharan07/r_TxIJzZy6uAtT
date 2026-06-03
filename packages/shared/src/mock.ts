/**
 * In-memory sample data. Mirrors the visual contract in the plan so the web app
 * renders real, type-checked data without a live Postgres/runner. In production
 * these rows come from the DB; the shapes are identical.
 */
import type { Eval, RunResult, User } from "./types.js";

export const MOCK_USER: User = {
  id: "u_jk",
  login: "jkim",
  avatarUrl: "",
  createdAt: "2026-05-20T00:00:00.000Z",
};

export const MOCK_EVAL: Eval = {
  id: "a3f9c2e1-8b47-4d2a",
  userId: MOCK_USER.id,
  shareToken: "cfg_a3f9c2e1",
  createdAt: "2026-06-01T14:00:00.000Z",
  config: {
    task:
      "Build a checkout flow using the Acme Payments SDK. Create a payment intent for $20, confirm it with a test card, and set up a webhook handler for payment_succeeded.",
    language: "node",
    context: [
      { type: "url", label: "https://docs.acme.dev/payments/quickstart", crawlDepth: "single" },
      { type: "repo", label: "github.com/acme/payments-sdk — /src, /examples", paths: ["/src", "/examples"] },
      { type: "file", label: "webhook-examples.ts (uploaded)", content: "// example webhook handler" },
    ],
    assertions: [
      { type: "http", name: "Server responds at localhost:3000/health", config: { url: "http://localhost:3000/health", expectStatus: 200 } },
      { type: "file", name: "File exists: src/checkout.ts", config: { path: "src/checkout.ts" } },
      { type: "shell", name: "node test.js", config: { command: "node test.js" } },
      { type: "llm", name: "Code follows SDK recommended patterns", config: { criterion: "Code follows the SDK's recommended patterns" } },
    ],
    metadata: { agentType: "claude-code", timeoutSec: 300 },
  },
};

const EVAL_TITLE = "Acme Payments SDK — Checkout Integration";

/** The failing baseline run shown on the report screen (Decision 6/9). */
export const MOCK_RUN: RunResult = {
  id: "a3f9c2e1-8b47-4d2a",
  evalId: MOCK_EVAL.id,
  evalTitle: EVAL_TITLE,
  task: MOCK_EVAL.config.task,
  agentType: "claude-code",
  status: "completed",
  errorType: null,
  startedAt: "2026-06-01T14:30:00.000Z",
  finishedAt: "2026-06-01T14:32:34.000Z",
  durationSec: 154,
  totalSteps: 17,
  tokens: 48000,
  verdicts: [
    { assertionIndex: 0, type: "shell", name: "SDK installed correctly", passed: true },
    { assertionIndex: 1, type: "shell", name: "API client initialized with auth", passed: true },
    { assertionIndex: 2, type: "http", name: "Payment intent created", passed: true },
    {
      assertionIndex: 3,
      type: "file",
      name: "Webhook handler registered",
      passed: false,
      hint: "agent looped on docs",
      output: "Expected src/webhook.ts to call webhooks.listen(); not found.",
    },
    {
      assertionIndex: 4,
      type: "llm",
      name: "Code follows SDK patterns",
      passed: false,
      hint: "wrong method signature",
      output: "The handler uses registerEndpoint(), which the SDK does not export.",
    },
  ],
  events: [
    { t: 0, kind: "command", text: "Installed acme-payments-sdk@3.2.1" },
    { t: 12, kind: "info", text: "Created client with API key" },
    { t: 38, kind: "api", text: "Called createPaymentIntent — 200 OK" },
    {
      t: 52,
      kind: "fail",
      text: "Read webhook docs 4 times — looped without progress",
      annotation:
        "The webhook setup docs reference registerEndpoint() but the SDK exports webhooks.listen(). The agent couldn't reconcile the mismatch.",
    },
    { t: 105, kind: "info", text: "Attempted manual webhook setup with express" },
    { t: 118, kind: "command", text: "npm run build" },
    { t: 121, kind: "info", text: "Re-read quickstart, section 'Webhooks'" },
    { t: 130, kind: "api", text: "POST /v1/webhooks — 404 Not Found" },
    { t: 140, kind: "info", text: "Edited src/checkout.ts" },
    { t: 154, kind: "warn", text: "Gave up on webhook registration" },
  ],
};

/** The improved run after the docs fix — used by the diff view (Decision 17). */
export const MOCK_RUN_FIXED: RunResult = {
  ...MOCK_RUN,
  id: "b7e2d4a8-1f93-4c6b",
  status: "completed",
  startedAt: "2026-06-02T10:15:00.000Z",
  finishedAt: "2026-06-02T10:17:05.000Z",
  durationSec: 125,
  totalSteps: 14,
  tokens: 41000,
  verdicts: MOCK_RUN.verdicts.map((v) =>
    v.passed ? v : { ...v, passed: true, hint: undefined, output: undefined }
  ),
};

/** A platform-error run for the error state (Decision 18). */
export const MOCK_RUN_ERROR: RunResult = {
  ...MOCK_RUN,
  id: "e0c1f5b2-3a44-4d11",
  status: "errored",
  errorType: "timeout",
  finishedAt: null,
  verdicts: [],
  events: MOCK_RUN.events.slice(0, 3),
};

const RUNS: Record<string, RunResult> = {
  [MOCK_RUN.id]: MOCK_RUN,
  [MOCK_RUN_FIXED.id]: MOCK_RUN_FIXED,
  [MOCK_RUN_ERROR.id]: MOCK_RUN_ERROR,
};

export function getRun(id: string): RunResult | null {
  return RUNS[id] ?? RUNS[MOCK_RUN.id] ?? null;
}

export function getEval(id: string): Eval | null {
  return id === MOCK_EVAL.id ? MOCK_EVAL : MOCK_EVAL;
}
