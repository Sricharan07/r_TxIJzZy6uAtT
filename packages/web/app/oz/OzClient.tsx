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

interface EventsResponse {
  events?: OzEvent[];
  cursor?: string | null;
  error?: string;
}

interface StreamResponse {
  job: OzJob;
  artifacts: OzArtifact[];
  events: OzEvent[];
  cursor?: string | null;
  error?: string;
}

interface ActionResponse {
  job?: OzJob;
  ok?: boolean;
  error?: string;
  blockers?: string[];
  missingSecrets?: string[];
}

interface RunInfrastructureHealth {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; message: string; checkedAt: string }>;
  blockers: string[];
}

interface OzClientUser {
  login: string;
  avatarUrl: string;
}

interface OzClientProps {
  user: OzClientUser | null;
}

const MODE_LABELS: Array<{ mode: OzMode; label: string; detail: string }> = [
  { mode: "copilot", label: "Copilot", detail: "Oz discovers and generates; you approve before run." },
  { mode: "autopilot", label: "Autopilot", detail: "Oz runs automatically when no secrets block it." },
  { mode: "manual", label: "Manual", detail: "Use the existing low-level builder." },
];

const PHASES: Array<{ status: OzJob["status"]; label: string }> = [
  { status: "discovering", label: "Discover" },
  { status: "profiling", label: "Profile" },
  { status: "mapping_docs", label: "Map" },
  { status: "generating_suite", label: "Suite" },
  { status: "awaiting_approval", label: "Approve" },
  { status: "running", label: "Run" },
  { status: "complete", label: "Report" },
];

const TERMINAL = new Set<OzJob["status"]>(["awaiting_approval", "blocked", "failed", "complete", "stopped"]);

function confidence(n?: number): string {
  return `${Math.round((n ?? 0) * 100)}%`;
}

function phaseLabel(status: OzJob["status"]): string {
  return status.replaceAll("_", " ");
}

function mergeEvents(current: OzEvent[], incoming: OzEvent[]): OzEvent[] {
  const seen = new Set(current.map((event) => event.id ?? `${event.kind}:${event.createdAt}:${event.message}`));
  const next = [...current];
  for (const event of incoming) {
    const key = event.id ?? `${event.kind}:${event.createdAt}:${event.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(event);
  }
  return next;
}

function eventTone(event: OzEvent): string {
  const severity = typeof event.payload?.severity === "string" ? event.payload.severity : "";
  if (event.kind.includes("failed") || event.kind.includes("blocked") || severity === "critical") return "critical";
  if (severity === "warning") return "warning";
  if (event.kind === "report.created" || event.kind === "suite.ready") return "success";
  return "info";
}

function eventTitle(event: OzEvent): string {
  return event.kind
    .replaceAll(".", " ")
    .split(" ")
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ");
}

function phaseIndexForStatus(status: OzJob["status"]): number {
  const explicit = PHASES.findIndex((item) => item.status === status);
  if (explicit >= 0) return explicit;
  if (status === "blocked") return PHASES.findIndex((item) => item.status === "awaiting_approval");
  if (status === "stopped") return PHASES.findIndex((item) => item.status === "running");
  if (status === "failed") return PHASES.findIndex((item) => item.status === "running");
  return 0;
}

function OzPageInner({ user }: OzClientProps) {
  const router = useRouter();
  const search = useSearchParams();
  const jobId = search.get("job");
  const [productUrl, setProductUrl] = useState("");
  const [mode, setMode] = useState<OzMode>("copilot");
  const [goal, setGoal] = useState("");
  const [job, setJob] = useState<OzJob | null>(null);
  const [events, setEvents] = useState<OzEvent[]>([]);
  const [visibleEvents, setVisibleEvents] = useState<OzEvent[]>([]);
  const [eventQueue, setEventQueue] = useState<OzEvent[]>([]);
  const [artifacts, setArtifacts] = useState<OzArtifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftSuite, setDraftSuite] = useState<OzSuiteDraft | null>(null);
  const [streamVersion, setStreamVersion] = useState(0);
  const [loadingJob, setLoadingJob] = useState(false);
  const [infraHealth, setInfraHealth] = useState<RunInfrastructureHealth | null>(null);
  const [runBlockers, setRunBlockers] = useState<string[]>([]);
  const live = job ? !TERMINAL.has(job.status) : false;
  const signedIn = Boolean(user);

  async function load(id: string): Promise<string | null> {
    const [jobRes, eventsRes] = await Promise.all([
      fetch(`/api/oz/jobs/${encodeURIComponent(id)}`, { credentials: "include" }),
      fetch(`/api/oz/jobs/${encodeURIComponent(id)}/events?limit=250`, { credentials: "include" }),
    ]);
    const jobBody = (await jobRes.json()) as JobResponse;
    const eventsBody = (await eventsRes.json()) as EventsResponse;
    if (!jobRes.ok) throw new Error(jobBody.error ?? "Could not load Oz job.");
    setJob(jobBody.job);
    setArtifacts(jobBody.artifacts ?? []);
    setDraftSuite(jobBody.job.state.suiteDraft ?? null);
    const nextEvents = eventsBody.events ?? [];
    setEvents(nextEvents);
    setVisibleEvents(nextEvents.slice(-80));
    setEventQueue([]);
    setRunBlockers([]);
    return eventsBody.cursor ?? nextEvents.at(-1)?.id ?? null;
  }

  useEffect(() => {
    if (!jobId) {
      setLoadingJob(false);
      return;
    }
    let cancelled = false;
    let source: EventSource | null = null;
    const start = async () => {
      setLoadingJob(true);
      try {
        const cursor = await load(jobId);
        if (cancelled) return;
        source = new EventSource(
          `/api/oz/jobs/${encodeURIComponent(jobId)}/stream${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`,
          { withCredentials: true },
        );
        source.addEventListener("oz", (message) => {
          const data = JSON.parse((message as MessageEvent).data) as StreamResponse;
          if (data.error) {
            setError(data.error);
            return;
          }
          setJob(data.job);
          setArtifacts(data.artifacts ?? []);
          setDraftSuite(data.job.state.suiteDraft ?? null);
          setEvents((current) => mergeEvents(current, data.events ?? []));
          setEventQueue((current) => mergeEvents(current, data.events ?? []));
          if (TERMINAL.has(data.job.status)) source?.close();
        });
        source.addEventListener("error", () => {
          source?.close();
        });
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Could not load Oz job.";
          setJob(null);
          setEvents([]);
          setVisibleEvents([]);
          setEventQueue([]);
          setArtifacts([]);
          setDraftSuite(null);
          if (message.includes("GitHub sign-in")) setAuthRequired(true);
          else if (!message.includes("not found")) setError(message);
          router.replace("/oz");
        }
      } finally {
        if (!cancelled) setLoadingJob(false);
      }
    };
    void start();
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [jobId, streamVersion]);

  useEffect(() => {
    if (eventQueue.length === 0) return;
    const id = setInterval(() => {
      setEventQueue((current) => {
        const [next, ...rest] = current;
        if (next) setVisibleEvents((visible) => mergeEvents(visible, [next]).slice(-80));
        return rest;
      });
    }, 420);
    return () => clearInterval(id);
  }, [eventQueue.length]);

  useEffect(() => {
    if (!job || (job.status !== "awaiting_approval" && job.status !== "running")) return;
    let cancelled = false;
    const refreshHealth = async () => {
      try {
        const response = await fetch("/api/system/health", { credentials: "include" });
        const health = (await response.json()) as RunInfrastructureHealth;
        if (!cancelled) setInfraHealth(health);
      } catch {
        if (!cancelled) {
          setInfraHealth({
            ok: false,
            checks: [],
            blockers: ["system: Could not load run infrastructure health."],
          });
        }
      }
    };
    void refreshHealth();
    const timer = setInterval(refreshHealth, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job?.id, job?.status]);

  const docsMap = useMemo(() => {
    const artifact = artifacts.find((item) => item.type === "docs_map");
    return Array.isArray(artifact?.data)
      ? artifact.data as Array<{ surface: string; surfaces?: string[]; sourceUrl: string; signal: string; signals?: string[]; confidence: number }>
      : [];
  }, [artifacts]);
  const currentPhase = job ? phaseIndexForStatus(job.status) : 0;
  const latestEvent = visibleEvents.at(-1);
  const docsCount = docsMap.length;
  const scenarioCount = draftSuite?.scenarios.length ?? 0;
  const runCount = job?.state.run?.runIds.length ?? 0;
  const requiredSecrets = job?.state.productProfile?.requiredEnv.length ?? 0;
  const missingSecrets = job?.state.verification?.missingSecrets ?? [];
  const currentRunBlockers = runBlockers.length > 0 ? runBlockers : infraHealth && !infraHealth.ok ? infraHealth.blockers : [];
  const canRunSuite = Boolean(
    job?.status === "awaiting_approval"
      && draftSuite?.scenarios.length
      && missingSecrets.length === 0
      && !(infraHealth && !infraHealth.ok)
      && !busy,
  );

  async function startJob() {
    if (mode === "manual") {
      router.push("/evals/new");
      return;
    }
    setBusy(true);
    setError(null);
    setRunBlockers([]);
    setAuthRequired(false);
    if (!signedIn) {
      setAuthRequired(true);
      setError("GitHub sign-in required");
      setBusy(false);
      return;
    }
    try {
      const res = await fetch("/api/oz/jobs", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productUrl, mode, userGoal: goal || undefined, preferredLanguage: "node", agentTargets: ["claude-code"] }),
      });
      const body = (await res.json()) as JobResponse;
      if (!res.ok) {
        if (res.status === 401) setAuthRequired(true);
        throw new Error(body.error ?? "Could not create Oz job.");
      }
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
    setRunBlockers([]);
    try {
      const res = await fetch(`/api/oz/jobs/${encodeURIComponent(job.id)}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const data = (await res.json()) as JobResponse & ActionResponse;
      if (!res.ok) {
        setRunBlockers(data.blockers ?? []);
        throw new Error(data.error ?? "Oz request failed.");
      }
      await load(job.id);
      setStreamVersion((version) => version + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Oz request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function stopJob() {
    if (!job) return;
    setBusy(true);
    setError(null);
    setRunBlockers([]);
    try {
      const res = await fetch(`/api/oz/jobs/${encodeURIComponent(job.id)}/stop`, { method: "POST", credentials: "include" });
      const data = (await res.json()) as ActionResponse;
      if (!res.ok) throw new Error(data.error ?? "Could not stop Oz job.");
      await load(job.id);
      setStreamVersion((version) => version + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop Oz job.");
    } finally {
      setBusy(false);
    }
  }

  async function clearCurrentJob() {
    setJob(null);
    setEvents([]);
    setVisibleEvents([]);
    setEventQueue([]);
    setArtifacts([]);
    setDraftSuite(null);
    setInfraHealth(null);
    setRunBlockers([]);
    router.push("/oz");
  }

  async function deleteJob(method: "DELETE" | "TERMINATE") {
    if (!job) return;
    const destructive = method === "TERMINATE" ? "terminate this job and remove its run data" : "delete this saved job";
    if (!window.confirm(`Are you sure you want to ${destructive}?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = method === "TERMINATE"
        ? await fetch(`/api/oz/jobs/${encodeURIComponent(job.id)}/terminate`, { method: "POST", credentials: "include" })
        : await fetch(`/api/oz/jobs/${encodeURIComponent(job.id)}`, { method: "DELETE", credentials: "include" });
      const data = (await res.json()) as ActionResponse;
      if (!res.ok) throw new Error(data.error ?? "Could not clean up Oz job.");
      await clearCurrentJob();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clean up Oz job.");
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

  if (jobId && loadingJob && !job) {
    return (
      <div className="oz-page">
        <section className="oz-loading-state">
          <div className="oz-loading-orb" aria-hidden />
          <p className="eyebrow">Oz agent</p>
          <h1>Opening the job.</h1>
          <p>Fetching the latest state, artifacts, and live event cursor.</p>
        </section>
      </div>
    );
  }

  if (!jobId || !job) {
    return (
      <div className="oz-page">
        <section className="oz-hero">
          <div className="oz-hero-copy">
            <p className="eyebrow">Oz agent</p>
            <h1>Agent readiness, made inspectable.</h1>
            <p>Give Oz a product surface. It will build a suite, expose what it inferred, and show every run as it happens.</p>
          </div>

          <div className="oz-launch-grid">
            <div className="oz-launch-panel">
              <div className="oz-signin-card">
                <div>
                  <strong>{signedIn ? "Workspace connected" : "Workspace access"}</strong>
                  <span>
                    {signedIn
                      ? `Jobs, runs, and reports are tied to ${user?.login}.`
                      : "Sign in so jobs, runs, and reports are tied to your account."}
                  </span>
                </div>
                {signedIn ? (
                  <span className="oz-session-chip">
                    {user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : null}
                    {user?.login}
                  </span>
                ) : (
                  <Link className="btn btn-primary github-btn" href="/auth/github?returnTo=/oz">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                      <path d="M8 0C3.58 0 0 3.67 0 8.2c0 3.62 2.29 6.69 5.47 7.78.4.08.55-.18.55-.39 0-.19-.01-.84-.01-1.52-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.96-.82-1.15-.28-.16-.68-.55-.01-.56.63-.01 1.08.59 1.23.84.72 1.24 1.87.89 2.33.68.07-.53.28-.89.51-1.09-1.78-.21-3.64-.91-3.64-4.03 0-.89.31-1.62.82-2.19-.08-.21-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.37 7.37 0 0 1 8 4.02c.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.95.08 2.16.51.57.82 1.3.82 2.19 0 3.13-1.87 3.82-3.65 4.03.29.26.54.75.54 1.52 0 1.09-.01 1.97-.01 2.24 0 .21.15.47.55.39A8.1 8.1 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z" />
                    </svg>
                    Continue with GitHub
                  </Link>
                )}
              </div>

              <label className="field-label" htmlFor="oz-product-url">Product URL</label>
              <div className="oz-url-row">
                <input id="oz-product-url" className="input oz-url-input" value={productUrl} onChange={(e) => setProductUrl(e.target.value)} placeholder="https://yourproduct.com" />
                <button className="btn btn-primary" disabled={busy || !productUrl.trim()} onClick={startJob}>
                  {busy ? "Starting..." : "Start Oz"}
                </button>
              </div>
              <textarea className="input compact" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Optional focus, e.g. Node SDK, auth, webhooks, or first successful API call" />

              <div className="oz-mode-grid">
                {MODE_LABELS.map((item) => (
                  <button key={item.mode} className={`oz-mode${mode === item.mode ? " selected" : ""}`} onClick={() => setMode(item.mode)}>
                    <strong>{item.label}</strong>
                    <span>{item.detail}</span>
                  </button>
                ))}
              </div>

              <div className="oz-launch-actions">
                <Link href="/evals/new" className="btn btn-ghost">Open Manual Builder</Link>
              </div>
              {authRequired && (
                <div className="oz-auth-error">
                  <span>GitHub sign-in is required before Oz can create a job.</span>
                  <Link className="btn btn-primary github-btn" href="/auth/github?returnTo=/oz">Continue with GitHub</Link>
                </div>
              )}
              {error && <p className="form-error">{error}</p>}
            </div>

            <aside className="oz-signal-panel">
              <p className="eyebrow">Run shape</p>
              <div className="oz-signal-row"><span>1</span><strong>Discover</strong><em>Docs, SDKs, auth, examples</em></div>
              <div className="oz-signal-row"><span>2</span><strong>Draft</strong><em>Scenarios, assertions, probes</em></div>
              <div className="oz-signal-row"><span>3</span><strong>Observe</strong><em>Live agent trace and report</em></div>
              <div className="oz-signal-foot">Transparent by default. Every inference has a visible artifact.</div>
            </aside>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="oz-page">
      <div className="oz-header">
        <div>
          <p className="eyebrow">Oz agent</p>
          <h1>{job.state.productProfile?.productName ?? "Agentic evaluation"}</h1>
          <p>{job.inputUrl}</p>
        </div>
        <div className="oz-header-actions">
          <span className={`oz-live-pill${live ? " active" : ""}`}><span />{live ? "Live" : "Idle"}</span>
          {job.status === "running" && <button className="btn btn-ghost" disabled={busy} onClick={stopJob}>{busy ? "Stopping..." : "Stop"}</button>}
          {job && <button className="btn btn-danger" disabled={busy} onClick={() => void deleteJob("TERMINATE")}>Terminate</button>}
          {job && <button className="btn btn-ghost danger-text" disabled={busy} onClick={() => void deleteJob("DELETE")}>Delete</button>}
          <Link className="btn btn-ghost" href="/oz">New Oz Job</Link>
        </div>
      </div>

      <section className="oz-status-board">
        <div>
          <span>Phase</span>
          <strong>{phaseLabel(job.status)}</strong>
        </div>
        <div>
          <span>Docs</span>
          <strong>{docsCount}</strong>
        </div>
        <div>
          <span>Scenarios</span>
          <strong>{scenarioCount}</strong>
        </div>
        <div>
          <span>Runs</span>
          <strong>{runCount}</strong>
        </div>
        <div>
          <span>Secrets</span>
          <strong>{requiredSecrets}</strong>
        </div>
      </section>

      {job && (
        <section className="oz-phase-strip" aria-label="Oz progress">
          {PHASES.map((phase) => {
            const index = PHASES.findIndex((item) => item.status === phase.status);
            const state = index < currentPhase || job.status === "complete" ? "done" : index === currentPhase ? "current" : "pending";
            return <div key={phase.status} className={`oz-phase ${state}`} aria-current={state === "current" ? "step" : undefined}><span />{phase.label}</div>;
          })}
        </section>
      )}

      <section className="oz-now">
        <div>
          <p className="eyebrow">Current signal</p>
          <strong>{latestEvent ? eventTitle(latestEvent) : "Waiting for activity"}</strong>
          <span>{latestEvent?.message ?? "Oz will stream discovery, suite, and run events here."}</span>
        </div>
      </section>

      <section className="oz-timeline">
        <div className="oz-timeline-title">
          <div>
            <p className="eyebrow">Live activity</p>
            <strong>Event stream</strong>
          </div>
          <span>{events.length} event{events.length === 1 ? "" : "s"} tracked</span>
        </div>
        {visibleEvents.length === 0 && (
          <div className="oz-empty-events">
            <strong>No events yet</strong>
            <p>Oz will show discovery, approval, run, and report events as they arrive.</p>
          </div>
        )}
        {visibleEvents.map((event) => (
          <div key={event.id ?? `${event.kind}-${event.createdAt}`} className={`oz-event ${eventTone(event)}`}>
            <span className="oz-event-dot" />
            <div>
              <strong>{eventTitle(event)}</strong>
              <p>{event.message}</p>
            </div>
          </div>
        ))}
        {eventQueue.length > 0 && <div className="oz-event oz-event-pending"><span className="oz-event-dot" /><p>{eventQueue.length} update{eventQueue.length === 1 ? "" : "s"} queued</p></div>}
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
                <strong>{item.surfaces?.join(", ") ?? item.surface}</strong>
                <span>{item.signals?.join(", ") ?? item.signal}</span>
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
          {job.status === "awaiting_approval" && (
            <div className={`oz-approval${missingSecrets.length || currentRunBlockers.length ? " blocked" : ""}`}>
              <div>
                <strong>{missingSecrets.length || currentRunBlockers.length ? "Resolve blockers before running." : "Oz is ready to run."}</strong>
                <p>
                  {missingSecrets.length
                    ? `Missing secrets: ${missingSecrets.join(", ")}`
                    : currentRunBlockers.length
                      ? currentRunBlockers.join(" ")
                      : "Estimated risk: low"}
                </p>
              </div>
              <button className="btn btn-primary" disabled={!canRunSuite} onClick={() => post("/run", { agentType: "claude-code", requestedRuns: 1 })}>
                {busy ? "Working..." : "Run test suite"}
              </button>
            </div>
          )}
        </section>
      )}

      {job?.state.run?.runIds.length ? (
        <section className="oz-panel">
          <div className="oz-panel-header">
            <h2>{job.status === "stopped" ? "Stopped run" : job.status === "complete" ? "Run reports" : "Live run"}</h2>
            <span className="badge">{job.state.run.runIds.length} run{job.state.run.runIds.length === 1 ? "" : "s"}</span>
          </div>
          <p>
            {job.status === "stopped"
              ? "The queued or active runs were canceled and will not produce a product grade."
              : job.status === "running"
                ? "Oz is watching the run queue, agent trace, and report links."
                : "These reports are ready to inspect."}
          </p>
          {job.status === "running" && infraHealth && !infraHealth.ok && (
            <div className="oz-run-blockers">
              {infraHealth.blockers.map((blocker) => <span key={blocker}>{blocker}</span>)}
            </div>
          )}
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
          {job.state.report.recommendedFixes.map((fix, index) => (
            <div className="finding-row" key={`${fix.title}-${index}`}>
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

export default function OzPage(props: OzClientProps) {
  return (
    <Suspense fallback={<div className="oz-page">Loading Oz...</div>}>
      <OzPageInner {...props} />
    </Suspense>
  );
}
