"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  {
    type: "paste",
    label: "SDK quickstart",
    content: "Create src/checkout.ts and document the checkout scaffold in README.md.",
  },
];

const DEFAULT_ASSERTIONS: Assertion[] = [
  { type: "file", name: "File exists: src/checkout.ts", config: { path: "src/checkout.ts" } },
  { type: "shell", name: "Checkout file is visible", config: { command: "test -f src/checkout.ts" } },
  { type: "llm", name: "README describes checkout scaffold", config: { criterion: "checkout scaffold" } },
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

function NewEvalForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [step, setStep] = useState(1);
  const [task, setTask] = useState(
    "Build a checkout flow using the Acme Payments SDK. Create a payment intent for $20, confirm it with a test card, and set up a webhook handler for payment_succeeded."
  );
  const [language, setLanguage] = useState<Language>("node");
  const [contexts, setContexts] = useState<ContextSource[]>(DEFAULT_CONTEXT);
  const [assertions, setAssertions] = useState<Assertion[]>(DEFAULT_ASSERTIONS);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const source = searchParams.get("from");
    if (!source) return;
    let cancelled = false;
    void fetch(`/api/evals/${encodeURIComponent(source)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { eval?: { config: { task: string; language: Language; context: ContextSource[]; assertions: Assertion[] } } } | null) => {
        if (cancelled || !data?.eval) return;
        setTask(data.eval.config.task);
        setLanguage(data.eval.config.language);
        setContexts(data.eval.config.context);
        setAssertions(data.eval.config.assertions);
      });
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

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

  function updateContext(idx: number, patch: Partial<ContextSource>) {
    setContexts((current) => current.map((source, i) => (i === idx ? { ...source, ...patch } : source)));
  }

  function addAssertion(t: (typeof ASSERT_TEMPLATES)[number]) {
    setAssertions((a) => [...a, { type: t.type, name: t.name, config: t.config }]);
  }

  function updateAssertionName(idx: number, name: string) {
    setAssertions((current) => current.map((a, i) => (i === idx ? { ...a, name } : a)));
  }

  function updateAssertionConfig(idx: number, config: Assertion["config"]) {
    setAssertions((current) => current.map((a, i) => (i === idx ? { ...a, config } : a)));
  }

  async function run() {
    setSubmitting(true);
    setSubmitError(null);
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
      const data = (await res.json()) as { runId?: string; reportUrl?: string; error?: string };
      if (!res.ok || !data.reportUrl) {
        throw new Error(data.error ?? "Could not start eval.");
      }
      router.push(data.reportUrl);
      return;
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not start eval.");
    }
    setSubmitting(false);
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
                <input
                  className="inline-input"
                  value={c.label}
                  onChange={(e) => updateContext(i, { label: e.target.value })}
                  aria-label={`${c.type} source`}
                />
                {c.type === "url" && (
                  <button
                    className={`mini-toggle${c.crawlDepth === "linked" ? " selected" : ""}`}
                    onClick={() =>
                      updateContext(i, {
                        crawlDepth: c.crawlDepth === "linked" ? "single" : "linked",
                      })
                    }
                  >
                    {c.crawlDepth === "linked" ? "linked pages" : "single page"}
                  </button>
                )}
                <button
                  className="ctx-remove"
                  aria-label="Remove source"
                  onClick={() => setContexts((cs) => cs.filter((_, j) => j !== i))}
                >
                  ×
                </button>
                {(c.type === "file" || c.type === "paste") && (
                  <>
                    {c.type === "file" && (
                      <input
                        className="file-input"
                        type="file"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (!file) return;
                          void file.text().then((content) => updateContext(i, { label: file.name, content }));
                        }}
                      />
                    )}
                    <textarea
                      className="input compact"
                      value={c.content ?? ""}
                      onChange={(e) => updateContext(i, { content: e.target.value })}
                      placeholder={c.type === "file" ? "Uploaded file contents" : "Paste docs or code snippet"}
                    />
                  </>
                )}
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
          <details className="context-preview context-bundle-preview">
            <summary>
              Agent will see {contexts.length} source{contexts.length === 1 ? "" : "s"} · ~
              {tokenEstimate.toLocaleString("en-US")} tokens
            </summary>
            <pre>
              {contexts
                .map((source) => `### ${source.type}: ${source.label}\n${source.content ?? "Fetched fresh when the run starts."}`)
                .join("\n\n")}
            </pre>
          </details>
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
                <input
                  className="inline-input"
                  value={a.name}
                  onChange={(e) => updateAssertionName(i, e.target.value)}
                  aria-label={`${a.type} assertion name`}
                />
                <button
                  className="ctx-remove"
                  aria-label="Remove assertion"
                  onClick={() => setAssertions((as) => as.filter((_, j) => j !== i))}
                >
                  ×
                </button>
                {a.type === "http" && (
                  <div className="assert-config">
                    <input
                      className="inline-input"
                      value={(a.config as { url: string }).url}
                      onChange={(e) =>
                        updateAssertionConfig(i, { ...(a.config as { url: string; expectStatus?: number; expectBodyContains?: string }), url: e.target.value })
                      }
                      aria-label="HTTP URL"
                    />
                    <input
                      className="inline-input small"
                      value={(a.config as { expectStatus?: number }).expectStatus ?? 200}
                      onChange={(e) =>
                        updateAssertionConfig(i, {
                          ...(a.config as { url: string; expectStatus?: number; expectBodyContains?: string }),
                          expectStatus: Number(e.target.value),
                        })
                      }
                      aria-label="Expected status"
                    />
                  </div>
                )}
                {a.type === "file" && (
                  <div className="assert-config">
                    <input
                      className="inline-input"
                      value={(a.config as { path: string }).path}
                      onChange={(e) =>
                        updateAssertionConfig(i, { ...(a.config as { path: string; contains?: string }), path: e.target.value })
                      }
                      aria-label="File path"
                    />
                    <input
                      className="inline-input"
                      value={(a.config as { contains?: string }).contains ?? ""}
                      onChange={(e) =>
                        updateAssertionConfig(i, {
                          ...(a.config as { path: string; contains?: string }),
                          contains: e.target.value || undefined,
                        })
                      }
                      placeholder="Optional contains"
                      aria-label="Expected file contents"
                    />
                  </div>
                )}
                {a.type === "shell" && (
                  <div className="assert-config">
                    <input
                      className="inline-input mono"
                      value={(a.config as { command: string }).command}
                      onChange={(e) =>
                        updateAssertionConfig(i, { ...(a.config as { command: string; cwd?: string }), command: e.target.value })
                      }
                      aria-label="Shell command"
                    />
                  </div>
                )}
                {a.type === "llm" && (
                  <div className="assert-config">
                    <textarea
                      className="input compact"
                      value={(a.config as { criterion: string }).criterion}
                      onChange={(e) => updateAssertionConfig(i, { criterion: e.target.value })}
                      aria-label="LLM criterion"
                    />
                  </div>
                )}
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
      {submitError && <p className="form-error">{submitError}</p>}
    </div>
  );
}

export default function NewEvalPage() {
  return (
    <Suspense fallback={<div className="form-wrapper">Loading eval form...</div>}>
      <NewEvalForm />
    </Suspense>
  );
}
