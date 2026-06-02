"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  Assertion,
  AssertionType,
  ContextSource,
  ContextSourceType,
  Language,
} from "@kiln/shared";

const LANGUAGES: { value: Language; label: string }[] = [
  { value: "node", label: "Node.js" },
  { value: "python", label: "Python" },
  { value: "go", label: "Go" },
  { value: "other", label: "Other" },
];

const STEP_LABELS = ["Task", "Context", "Tests", "Run"];

// Defaults mirror the sample eval so first-time users (Decision 14) see a worked example.
const DEFAULT_CONTEXT: ContextSource[] = [
  { type: "url", label: "https://docs.acme.dev/payments/quickstart", crawlDepth: "single" },
  { type: "repo", label: "github.com/acme/payments-sdk — /src, /examples", paths: ["/src", "/examples"] },
  { type: "file", label: "webhook-examples.ts (uploaded)", content: "// example webhook handler" },
];

const DEFAULT_ASSERTIONS: Assertion[] = [
  { type: "http", name: "Server responds at localhost:3000/health", config: { url: "http://localhost:3000/health", expectStatus: 200 } },
  { type: "file", name: "File exists: src/checkout.ts", config: { path: "src/checkout.ts" } },
  { type: "shell", name: "node test.js", config: { command: "node test.js" } },
  { type: "llm", name: "Code follows SDK recommended patterns", config: { criterion: "Code follows the SDK's recommended patterns" } },
];

const CTX_ADD: { type: ContextSourceType; label: string }[] = [
  { type: "url", label: "Crawl URL" },
  { type: "repo", label: "GitHub Repo" },
  { type: "file", label: "Upload Files" },
  { type: "paste", label: "Paste Text" },
];

const ASSERT_TEMPLATES: { type: AssertionType; label: string; color: string; name: string; config: Assertion["config"] }[] = [
  { type: "http", label: "HTTP check", color: "var(--blue-light)", name: "HTTP endpoint returns 200", config: { url: "http://localhost:3000/", expectStatus: 200 } },
  { type: "file", label: "File exists", color: "var(--green)", name: "File exists: src/index.ts", config: { path: "src/index.ts" } },
  { type: "file", label: "File contains", color: "var(--green)", name: "File contains string", config: { path: "src/index.ts", contains: "" } },
  { type: "shell", label: "Shell command", color: "var(--yellow)", name: "npm test", config: { command: "npm test" } },
  { type: "llm", label: "LLM judge", color: "var(--purple-light)", name: "Code follows SDK patterns", config: { criterion: "Code follows the SDK's recommended patterns" } },
];

function ctxBadgeClass(t: ContextSourceType): string {
  return t === "repo" ? "repo" : t === "file" || t === "paste" ? "file" : "url";
}

export default function NewEvalPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [task, setTask] = useState(
    "Build a checkout flow using the Acme Payments SDK. Create a payment intent for $20, confirm it with a test card, and set up a webhook handler for payment_succeeded."
  );
  const [language, setLanguage] = useState<Language>("node");
  const [contexts, setContexts] = useState<ContextSource[]>(DEFAULT_CONTEXT);
  const [assertions, setAssertions] = useState<Assertion[]>(DEFAULT_ASSERTIONS);
  const [submitting, setSubmitting] = useState(false);

  const tokenEstimate = useMemo(() => {
    // Rough deterministic estimate: ~4k per source baseline + content length / 4.
    const base = contexts.length * 4000;
    const extra = contexts.reduce((n, c) => n + (c.content?.length ?? 0), 0) / 4;
    return Math.round((base + extra) / 100) * 100;
  }, [contexts]);

  function addContext(type: ContextSourceType) {
    const labels: Record<ContextSourceType, string> = {
      url: "https://docs.example.com",
      repo: "github.com/org/repo",
      file: "uploaded-file.ts",
      paste: "Pasted snippet",
    };
    setContexts((c) => [...c, { type, label: labels[type] }]);
  }

  function addAssertion(t: (typeof ASSERT_TEMPLATES)[number]) {
    setAssertions((a) => [...a, { type: t.type, name: t.name, config: t.config }]);
  }

  const [error, setError] = useState<string | null>(null);

  async function run() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/evals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task,
          language,
          context: contexts,
          assertions,
          metadata: { agentType: "claude-code", timeoutSec: 300 },
        }),
      });
      const data = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !data.runId) {
        setError(data.error ?? "Failed to start the eval. Please try again.");
        setSubmitting(false);
        return;
      }
      // Navigate to the freshly created run's own report (Decision 6).
      router.push(`/reports/${data.runId}`);
    } catch {
      setError("Could not reach the server. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="form-wrapper">
      <div className="form-header">
        <h2>New Eval</h2>
        <p>Define what the agent should build, give it context, and set pass/fail tests.</p>
      </div>

      {/* Stepper (Decision 10) */}
      <div className="stepper">
        {STEP_LABELS.map((label, i) => {
          const n = i + 1;
          const state = n < step ? "done" : n === step ? "active" : "pending";
          return (
            <div key={label} style={{ display: "contents" }}>
              {i > 0 && <div className="step-line" />}
              <button
                className={`step ${state}`}
                style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}
                onClick={() => setStep(n)}
              >
                <span className="step-num">{state === "done" ? "✓" : n}</span>
                <span className="step-label">{label}</span>
              </button>
            </div>
          );
        })}
      </div>

      {step === 1 && (
        <div>
          <div className="field">
            <label className="field-label">What should the agent build?</label>
            <textarea
              className="input"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="e.g. Build a checkout flow using our Payments SDK..."
            />
            <p className="field-hint">
              Describe a realistic integration task that a developer would accomplish with your API.
            </p>
          </div>
          <div className="field">
            <label className="field-label">Language / runtime</label>
            <div className="lang-picker">
              {LANGUAGES.map((l) => (
                <button
                  key={l.value}
                  className={`lang-chip${language === l.value ? " selected" : ""}`}
                  onClick={() => setLanguage(l.value)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="field">
          <label className="field-label">Context sources</label>
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Add the docs, SDK files, and examples the agent should use.
          </div>
          <div className="context-sources">
            {contexts.map((c, i) => (
              <div className="context-source" key={i}>
                <span className={`ctx-badge ${ctxBadgeClass(c.type)}`}>{c.type}</span>
                <span className="ctx-name">{c.label}</span>
                <button
                  className="ctx-remove"
                  aria-label="Remove source"
                  onClick={() => setContexts((cs) => cs.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="context-add-btns">
            {CTX_ADD.map((b) => (
              <button key={b.type} className="ctx-add-btn" onClick={() => addContext(b.type)}>
                <span className="plus">+</span> {b.label}
              </button>
            ))}
          </div>
          <div className="context-preview">
            <span>
              Agent will see {contexts.length} source{contexts.length === 1 ? "" : "s"} · ~
              {tokenEstimate.toLocaleString("en-US")} tokens
            </span>
            <span style={{ color: "var(--green)", fontSize: "11px" }}>Preview →</span>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="field">
          <label className="field-label">Pass/fail assertions</label>
          <div className="field-hint" style={{ marginBottom: "10px" }}>
            Define how to verify the agent&apos;s work.
          </div>
          <div className="assertions">
            {assertions.map((a, i) => (
              <div className="assertion-row" key={i}>
                <span className={`assert-badge ${a.type}`}>{a.type.toUpperCase()}</span>
                <span className="assert-text">
                  {a.type === "shell" ? <code>{(a.config as { command: string }).command}</code> : a.name}
                </span>
                <button
                  className="ctx-remove"
                  aria-label="Remove assertion"
                  onClick={() => setAssertions((as) => as.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="assertion-templates">
            {ASSERT_TEMPLATES.map((t) => (
              <button key={t.label} className="tmpl-btn" onClick={() => addAssertion(t)}>
                <span style={{ color: t.color }}>+</span> {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {step === 4 && (
        <div>
          <div className="field">
            <label className="field-label">Review &amp; run</label>
            <div className="context-preview" style={{ display: "block" }}>
              <p style={{ marginBottom: "8px" }}>
                <strong>Task:</strong> {task}
              </p>
              <p style={{ marginBottom: "4px" }}>
                <strong>Language:</strong> {LANGUAGES.find((l) => l.value === language)?.label}
              </p>
              <p style={{ marginBottom: "4px" }}>
                <strong>Context:</strong> {contexts.length} sources · ~
                {tokenEstimate.toLocaleString("en-US")} tokens
              </p>
              <p>
                <strong>Assertions:</strong> {assertions.length} tests
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: "16px",
            padding: "10px 14px",
            borderRadius: "8px",
            background: "var(--red-bg)",
            border: "1px solid var(--red-border)",
            color: "var(--red-light)",
            fontSize: "12px",
          }}
        >
          {error}
        </div>
      )}

      <div className="form-nav">
        <button
          className="btn btn-ghost"
          disabled={step === 1}
          style={{ opacity: step === 1 ? 0.4 : 1 }}
          onClick={() => setStep((s) => Math.max(1, s - 1))}
        >
          ← Back{step > 1 ? `: ${STEP_LABELS[step - 2]}` : ""}
        </button>
        {step < 4 ? (
          <button className="btn btn-primary" onClick={() => setStep((s) => Math.min(4, s + 1))}>
            Next: {STEP_LABELS[step]} →
          </button>
        ) : (
          <button className="btn btn-primary" disabled={submitting} onClick={run}>
            {submitting ? "Starting…" : "Run Eval →"}
          </button>
        )}
      </div>
    </div>
  );
}
