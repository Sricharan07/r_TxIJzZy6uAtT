"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { OzArtifact, OzEvent, OzJob, OzMode, OzScenario, OzSuiteDraft } from "@kiln/shared";

interface JobResponse {
  job: OzJob;
  artifacts?: OzArtifact[];
  error?: string;
}

const MODE_LABELS: Array<{ mode: OzMode; label: string; detail: string }> = [
  { mode: "copilot", label: "Copilot", detail: "Oz discovers and generates; you approve before run." },
  { mode: "autopilot", label: "Autopilot", detail: "Oz runs automatically when no secrets block it." },
  { mode: "manual", label: "Manual", detail: "Use the existing low-level builder." },
];

function confidence(n?: number): string {
  return `${Math.round((n ?? 0) * 100)}%`;
}

function phaseLabel(status: OzJob["status"]): string {
  return status.replaceAll("_", " ");
}

function OzPageInner() {
  const router = useRouter();
  const search = useSearchParams();
  const jobId = search.get("job");
  const [productUrl, setProductUrl] = useState("");
  const [mode, setMode] = useState<OzMode>("copilot");
  const [goal, setGoal] = useState("");
  const [job, setJob] = useState<OzJob | null>(null);
  const [events, setEvents] = useState<OzEvent[]>([]);
  const [artifacts, setArtifacts] = useState<OzArtifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftSuite, setDraftSuite] = useState<OzSuiteDraft | null>(null);

  async function load(id: string) {
    const [jobRes, eventsRes] = await Promise.all([
      fetch(`/api/oz/jobs/${encodeURIComponent(id)}`),
      fetch(`/api/oz/jobs/${encodeURIComponent(id)}/events`),
    ]);
    const jobBody = (await jobRes.json()) as JobResponse;
    const eventsBody = (await eventsRes.json()) as { events?: OzEvent[]; error?: string };
    if (!jobRes.ok) throw new Error(jobBody.error ?? "Could not load Oz job.");
    setJob(jobBody.job);
    setArtifacts(jobBody.artifacts ?? []);
    setDraftSuite(jobBody.job.state.suiteDraft ?? null);
    setEvents(eventsBody.events ?? []);
  }

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        await load(jobId);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load Oz job.");
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [jobId]);

  const docsMap = useMemo(() => {
    const artifact = artifacts.find((item) => item.type === "docs_map");
    return Array.isArray(artifact?.data) ? artifact.data as Array<{ surface: string; sourceUrl: string; signal: string; confidence: number }> : [];
  }, [artifacts]);

  async function startJob() {
    if (mode === "manual") {
      router.push("/evals/new");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/oz/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productUrl, mode, userGoal: goal || undefined, preferredLanguage: "node", agentTargets: ["claude-code"] }),
      });
      const body = (await res.json()) as JobResponse;
      if (!res.ok) throw new Error(body.error ?? "Could not create Oz job.");
      router.push(`/oz?job=${body.job.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create Oz job.");
    } finally {
      setBusy(false);
    }
  }

  async function post(path: string, body?: unknown) {
    if (!job) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/oz/jobs/${encodeURIComponent(job.id)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await res.json()) as JobResponse;
      if (!res.ok) throw new Error(data.error ?? "Oz request failed.");
      await load(job.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Oz request failed.");
    } finally {
      setBusy(false);
    }
  }

  function updateScenario(id: string, patch: Partial<OzScenario>) {
    if (!draftSuite) return;
    setDraftSuite({
      ...draftSuite,
      scenarios: draftSuite.scenarios.map((scenario) => scenario.id === id ? { ...scenario, ...patch } : scenario),
    });
  }

  async function saveSuite() {
    if (!draftSuite) return;
    const scenarios = draftSuite.scenarios;
    await post("/edit-suite", {
      suiteDraft: {
        ...draftSuite,
        scenarios,
        assertions: scenarios.flatMap((scenario) => scenario.assertions),
        dynamicProbes: scenarios.flatMap((scenario) => scenario.dynamicProbes),
      },
    });
    setEditing(null);
  }

  async function removeScenario(id: string) {
    if (!draftSuite) return;
    const scenarios = draftSuite.scenarios.filter((scenario) => scenario.id !== id);
    const suiteDraft = {
      ...draftSuite,
      scenarios,
      assertions: scenarios.flatMap((scenario) => scenario.assertions),
      dynamicProbes: scenarios.flatMap((scenario) => scenario.dynamicProbes),
    };
    setDraftSuite(suiteDraft);
    await post("/edit-suite", { suiteDraft });
  }

  if (!jobId) {
    return (
      <div className="oz-page">
        <section className="oz-hero">
          <h1>Give Oz your product URL.</h1>
          <p>Oz discovers your docs, understands your API, generates an editable agent-readiness suite, and runs it against coding agents.</p>
          <div className="oz-url-row">
            <input className="input oz-url-input" value={productUrl} onChange={(e) => setProductUrl(e.target.value)} placeholder="https://yourproduct.com" />
            <button className="btn btn-primary" disabled={busy || !productUrl.trim()} onClick={startJob}>
              {busy ? "Starting..." : "Start Oz"}
            </button>
          </div>
          <textarea className="input compact" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Optional goal, e.g. focus on Node SDK and webhooks" />
          <div className="oz-mode-grid">
            {MODE_LABELS.map((item) => (
              <button key={item.mode} className={`oz-mode${mode === item.mode ? " selected" : ""}`} onClick={() => setMode(item.mode)}>
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
              </button>
            ))}
          </div>
          <Link href="/evals/new" className="nav-link">Open Manual Builder</Link>
          {error && <p className="form-error">{error}</p>}
        </section>
      </div>
    );
  }

  return (
    <div className="oz-page">
      <div className="oz-header">
        <div>
          <h1>Oz is mapping your product</h1>
          <p>{job ? `Current phase: ${phaseLabel(job.status)}` : "Loading job..."}</p>
        </div>
        <Link className="btn btn-ghost" href="/oz">New Oz Job</Link>
      </div>

      <section className="oz-timeline">
        {events.map((event) => (
          <div key={event.id ?? `${event.kind}-${event.createdAt}`} className={`oz-event ${event.kind.includes("failed") || event.kind.includes("blocked") ? "critical" : ""}`}>
            <span className="oz-event-dot" />
            <div>
              <strong>{event.kind.replaceAll(".", " ")}</strong>
              <p>{event.message}</p>
            </div>
          </div>
        ))}
      </section>

      {job?.state.productProfile && (
        <section className="oz-panel">
          <div className="oz-panel-header">
            <h2>Oz understood your product</h2>
            <span className="badge">{confidence(job.state.productProfile.confidence)}</span>
          </div>
          <div className="oz-intel-grid">
            <p><strong>Product:</strong> {job.state.productProfile.productName}</p>
            <p><strong>Type:</strong> {job.state.productProfile.productType.join(", ")}</p>
            <p><strong>Auth:</strong> {job.state.productProfile.auth?.scheme ?? "unknown"}</p>
            <p><strong>SDKs:</strong> {job.state.productProfile.sdks.map((sdk) => sdk.packageName).join(", ") || "none found"}</p>
            <p><strong>Required env:</strong> {job.state.productProfile.requiredEnv.map((env) => env.name).join(", ") || "none detected"}</p>
          </div>
          <p className="oz-summary">{job.state.productProfile.summary}</p>
        </section>
      )}

      {docsMap.length > 0 && (
        <section className="oz-panel">
          <h2>Docs map</h2>
          <div className="oz-docs-map">
            {docsMap.map((item) => (
              <div key={`${item.surface}-${item.sourceUrl}`} className="oz-doc-row">
                <strong>{item.surface}</strong>
                <span>{item.signal}</span>
                <a href={item.sourceUrl} target="_blank" rel="noreferrer">{new URL(item.sourceUrl).pathname || item.sourceUrl}</a>
              </div>
            ))}
          </div>
        </section>
      )}

      {draftSuite && (
        <section className="oz-panel">
          <div className="oz-panel-header">
            <h2>Editable test suite</h2>
            <span className="badge">{draftSuite.scenarios.length} scenarios</span>
          </div>
          <div className="oz-scenarios">
            {draftSuite.scenarios.map((scenario) => (
              <article key={scenario.id} className="oz-scenario-card">
                {editing === scenario.id ? (
                  <>
                    <input className="input" value={scenario.title} onChange={(e) => updateScenario(scenario.id, { title: e.target.value })} />
                    <textarea className="input" value={scenario.task} onChange={(e) => updateScenario(scenario.id, { task: e.target.value })} />
                    <textarea className="input compact" value={scenario.rationale} onChange={(e) => updateScenario(scenario.id, { rationale: e.target.value })} />
                    <div className="oz-card-actions">
                      <button className="btn btn-primary" onClick={saveSuite}>Save</button>
                      <button className="btn btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="oz-panel-header">
                      <h3>{scenario.title}</h3>
                      <span>{confidence(scenario.confidence)}</span>
                    </div>
                    <p className="oz-summary">{scenario.rationale}</p>
                    <p><strong>Task:</strong> {scenario.task}</p>
                    <div className="oz-assertions">
                      {scenario.assertions.map((assertion, idx) => (
                        <span key={`${assertion.name}-${idx}`} className={`assert-badge ${assertion.type}`}>{assertion.type}: {assertion.name}</span>
                      ))}
                    </div>
                    <div className="oz-card-actions">
                      <button className="tmpl-btn" onClick={() => setEditing(scenario.id)}>Edit</button>
                      <button className="tmpl-btn" onClick={() => void removeScenario(scenario.id)}>Remove</button>
                      <button className="tmpl-btn" onClick={() => post("/regenerate-scenario", { scenarioId: scenario.id })}>Regenerate</button>
                      <button className="tmpl-btn" onClick={() => post("/regenerate-scenario", { scenarioId: scenario.id, action: "make_stricter" })}>Make stricter</button>
                      <button className="tmpl-btn" onClick={() => post("/regenerate-scenario", { scenarioId: scenario.id, action: "make_simpler" })}>Make simpler</button>
                      <button className="tmpl-btn" onClick={() => post("/regenerate-scenario", { scenarioId: scenario.id, action: "add_negative_test" })}>Add negative test</button>
                      <button className="tmpl-btn" onClick={() => post("/regenerate-scenario", { scenarioId: scenario.id, action: "add_webhook_test" })}>Add webhook test</button>
                    </div>
                  </>
                )}
              </article>
            ))}
          </div>
          <div className="oz-approval">
            <div>
              <strong>Oz is ready to run.</strong>
              <p>{job?.state.verification?.missingSecrets.length ? `Missing secrets: ${job.state.verification.missingSecrets.join(", ")}` : "Estimated risk: low"}</p>
            </div>
            <button className="btn btn-primary" disabled={busy || !draftSuite.scenarios.length} onClick={() => post("/run", { agentType: "claude-code", requestedRuns: 1 })}>
              {busy ? "Working..." : "Run test suite"}
            </button>
          </div>
        </section>
      )}

      {job?.state.run?.runIds.length ? (
        <section className="oz-panel">
          <h2>Live run</h2>
          <p>Oz is watching {job.state.run.runIds.length} run{job.state.run.runIds.length === 1 ? "" : "s"}.</p>
          <div className="oz-run-links">
            {job.state.run.runIds.map((runId) => (
              <Link key={runId} className="tmpl-btn" href={`/reports/${runId}`}>Report {runId.slice(0, 8)}</Link>
            ))}
          </div>
        </section>
      ) : null}

      {job?.state.report && (
        <section className="oz-panel">
          <h2>Final DX report</h2>
          <p className="oz-summary">{job.state.report.summary}</p>
          {job.state.report.recommendedFixes.map((fix) => (
            <div className="finding-row" key={fix.title}>
              <strong>{fix.title}</strong>
              <p>{fix.detail}</p>
            </div>
          ))}
        </section>
      )}

      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

export default function OzPage() {
  return (
    <Suspense fallback={<div className="oz-page">Loading Oz...</div>}>
      <OzPageInner />
    </Suspense>
  );
}
