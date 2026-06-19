"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { OzArtifact, OzEvent, OzJob, OzMode, OzResearchReport, OzScenario, OzSuiteDraft, ProductSecretSummary } from "@kiln/shared";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClassName } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface JobResponse {
  job: OzJob;
  artifacts?: OzArtifact[];
  secrets?: ProductSecretSummary[];
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
const EVENT_FILTERS = [
  { id: "milestones", label: "Milestones" },
  { id: "all", label: "All" },
  { id: "agent", label: "Agent" },
  { id: "warnings", label: "Warnings" },
  { id: "failures", label: "Failures" },
] as const;

type EventFilter = (typeof EVENT_FILTERS)[number]["id"];

interface AgentProgressPayload {
  type?: string;
  subtype?: string;
  estimated_tokens?: number;
  estimated_tokens_delta?: number;
  session_id?: string;
}

interface DisplayEvent {
  id: string;
  title: string;
  message: string;
  rawTitle: string;
  rawMessage: string;
  timeLabel: string;
  tone: string;
  category: "milestone" | "agent" | "warning" | "failure";
  count: number;
  rawEvents: OzEvent[];
  isReasoning: boolean;
}

function confidence(n?: number): string {
  return `${Math.round((n ?? 0) * 100)}%`;
}

function phaseLabel(status: OzJob["status"]): string {
  return status.replaceAll("_", " ");
}

function insightLabel(value: string): string {
  return value.replaceAll("_", " ");
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

function parseAgentProgress(event: OzEvent): AgentProgressPayload | null {
  const agentProgress = event.message.match(/^Agent progress:\s*(\{.*\})$/);
  if (!agentProgress) return null;
  try {
    return JSON.parse(agentProgress[1]) as AgentProgressPayload;
  } catch {
    return null;
  }
}

function eventMessage(event: OzEvent): string {
  const payload = parseAgentProgress(event);
  if (!payload) return event.message;
  if (payload.type === "system" && payload.subtype === "thinking_tokens") {
    const total = typeof payload.estimated_tokens === "number" ? payload.estimated_tokens.toLocaleString() : "unknown";
    const delta = typeof payload.estimated_tokens_delta === "number" ? `+${payload.estimated_tokens_delta.toLocaleString()}` : "new";
    return `Agent is reasoning. ${total} thinking tokens tracked (${delta} since the last update).`;
  }
  if (payload.type) {
    return `Agent emitted ${payload.subtype ? `${payload.subtype.replaceAll("_", " ")} ` : ""}${payload.type} telemetry.`;
  }
  return event.message;
}

function eventTimeLabel(event: OzEvent): string {
  if (!event.createdAt) return "";
  return new Date(event.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function eventCategory(event: OzEvent, tone: string): DisplayEvent["category"] {
  if (tone === "critical") return "failure";
  if (tone === "warning") return "warning";
  if (event.kind.startsWith("run.")) return "agent";
  return "milestone";
}

function toDisplayEvent(event: OzEvent): DisplayEvent {
  const tone = eventTone(event);
  return {
    id: event.id ?? `${event.kind}:${event.createdAt}:${event.message}`,
    title: eventTitle(event),
    message: eventMessage(event),
    rawTitle: eventTitle(event),
    rawMessage: event.message,
    timeLabel: eventTimeLabel(event),
    tone,
    category: eventCategory(event, tone),
    count: 1,
    rawEvents: [event],
    isReasoning: false,
  };
}

function isReasoningTelemetry(event: OzEvent): boolean {
  const payload = parseAgentProgress(event);
  return payload?.type === "system" && payload.subtype === "thinking_tokens";
}

function reasoningDisplayEvent(group: OzEvent[]): DisplayEvent {
  const first = group[0]!;
  const latest = group.at(-1)!;
  return {
    id: `reasoning:${first.id ?? first.createdAt}:${latest.id ?? latest.createdAt}:${group.length}`,
    title: "Agent is reasoning",
    message: eventMessage(latest),
    rawTitle: eventTitle(latest),
    rawMessage: latest.message,
    timeLabel: eventTimeLabel(latest),
    tone: "info",
    category: "agent",
    count: group.length,
    rawEvents: group,
    isReasoning: true,
  };
}

function buildDisplayEvents(source: OzEvent[]): DisplayEvent[] {
  const display: DisplayEvent[] = [];
  let reasoningGroup: OzEvent[] = [];
  const flushReasoning = () => {
    if (reasoningGroup.length > 0) {
      display.push(reasoningDisplayEvent(reasoningGroup));
      reasoningGroup = [];
    }
  };

  for (const event of source) {
    if (isReasoningTelemetry(event)) {
      reasoningGroup.push(event);
      continue;
    }
    flushReasoning();
    display.push(toDisplayEvent(event));
  }
  flushReasoning();
  return display;
}

function eventMatchesFilter(event: DisplayEvent, filter: EventFilter): boolean {
  if (filter === "all") return true;
  if (filter === "agent") return event.category === "agent";
  if (filter === "warnings") return event.category === "warning";
  if (filter === "failures") return event.category === "failure";
  if (event.category === "agent") return event.isReasoning;
  return true;
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
  const [eventFilter, setEventFilter] = useState<EventFilter>("milestones");
  const [autoFollowFeed, setAutoFollowFeed] = useState(true);
  const [pendingFeedUpdates, setPendingFeedUpdates] = useState(0);
  const [artifacts, setArtifacts] = useState<OzArtifact[]>([]);
  const [secretSummaries, setSecretSummaries] = useState<ProductSecretSummary[]>([]);
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftSuite, setDraftSuite] = useState<OzSuiteDraft | null>(null);
  const [streamVersion, setStreamVersion] = useState(0);
  const [loadingJob, setLoadingJob] = useState(false);
  const [infraHealth, setInfraHealth] = useState<RunInfrastructureHealth | null>(null);
  const [runBlockers, setRunBlockers] = useState<string[]>([]);
  const feedRef = useRef<HTMLDivElement | null>(null);
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
    setSecretSummaries(jobBody.secrets ?? []);
    setDraftSuite(jobBody.job.state.suiteDraft ?? null);
    const nextEvents = eventsBody.events ?? [];
    setEvents(nextEvents);
    setAutoFollowFeed(true);
    setPendingFeedUpdates(0);
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
          setPendingFeedUpdates(0);
          setArtifacts([]);
          setSecretSummaries([]);
          setSecretInputs({});
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
  const research = useMemo(() => {
    if (job?.state.research) return job.state.research;
    const artifact = artifacts.find((item) => item.type === "research_report");
    return artifact?.data && typeof artifact.data === "object" ? artifact.data as OzResearchReport : null;
  }, [artifacts, job?.state.research]);
  const displayEvents = useMemo(() => buildDisplayEvents(events), [events]);
  const filteredDisplayEvents = useMemo(
    () => displayEvents.filter((event) => eventMatchesFilter(event, eventFilter)),
    [displayEvents, eventFilter],
  );
  const latestDisplayEvent = displayEvents.at(-1);
  const latestDisplayKey = latestDisplayEvent ? `${latestDisplayEvent.id}:${latestDisplayEvent.count}:${events.length}` : "empty";
  const currentPhase = job ? phaseIndexForStatus(job.status) : 0;
  const docsCount = docsMap.length;
  const researchConflictCount = research?.conflicts.length ?? 0;
  const researchClaimCount = research?.claims.length ?? 0;
  const scenarioCount = draftSuite?.scenarios.length ?? 0;
  const runCount = job?.state.run?.runIds.length ?? 0;
  const requiredSecrets = job?.state.productProfile?.requiredEnv.length ?? 0;
  const missingSecrets = job?.state.verification?.missingSecrets ?? [];
  const savedSecretNames = useMemo(() => new Set(secretSummaries.map((secret) => secret.name)), [secretSummaries]);
  const currentRunBlockers = runBlockers.length > 0 ? runBlockers : infraHealth && !infraHealth.ok ? infraHealth.blockers : [];
  const canRunSuite = Boolean(
    job?.status === "awaiting_approval"
      && draftSuite?.scenarios.length
      && missingSecrets.length === 0
      && !(infraHealth && !infraHealth.ok)
      && !busy,
  );

  function scrollFeedToLatest(behavior: ScrollBehavior = "smooth") {
    const feed = feedRef.current;
    if (!feed) return;
    feed.scrollTo({ top: feed.scrollHeight, behavior });
    setAutoFollowFeed(true);
    setPendingFeedUpdates(0);
  }

  function handleFeedScroll() {
    const feed = feedRef.current;
    if (!feed) return;
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 56;
    setAutoFollowFeed(nearBottom);
    if (nearBottom) setPendingFeedUpdates(0);
  }

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed) return;
    if (autoFollowFeed) {
      requestAnimationFrame(() => scrollFeedToLatest("smooth"));
      return;
    }
    if (filteredDisplayEvents.length > 0) {
      setPendingFeedUpdates((count) => Math.min(count + 1, 99));
    }
  }, [latestDisplayKey, eventFilter]);

  useEffect(() => {
    setAutoFollowFeed(true);
    setPendingFeedUpdates(0);
    requestAnimationFrame(() => scrollFeedToLatest("auto"));
  }, [eventFilter]);

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
    setPendingFeedUpdates(0);
    setAutoFollowFeed(true);
    setArtifacts([]);
    setSecretSummaries([]);
    setSecretInputs({});
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

  async function saveSecrets() {
    if (!job) return;
    setBusy(true);
    setError(null);
    setRunBlockers([]);
    try {
      const res = await fetch(`/api/oz/jobs/${encodeURIComponent(job.id)}/secrets`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: secretInputs }),
      });
      const data = (await res.json()) as JobResponse;
      if (!res.ok || !data.job) throw new Error(data.error ?? "Could not save product credentials.");
      setJob(data.job);
      setSecretSummaries(data.secrets ?? []);
      setSecretInputs({});
      await load(job.id);
      setStreamVersion((version) => version + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save product credentials.");
    } finally {
      setBusy(false);
    }
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
          <div className="oz-loading-mark" aria-hidden />
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
                  <Link className={buttonClassName({ className: "github-btn" })} href="/auth/github?returnTo=/oz">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                      <path d="M8 0C3.58 0 0 3.67 0 8.2c0 3.62 2.29 6.69 5.47 7.78.4.08.55-.18.55-.39 0-.19-.01-.84-.01-1.52-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.96-.82-1.15-.28-.16-.68-.55-.01-.56.63-.01 1.08.59 1.23.84.72 1.24 1.87.89 2.33.68.07-.53.28-.89.51-1.09-1.78-.21-3.64-.91-3.64-4.03 0-.89.31-1.62.82-2.19-.08-.21-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.37 7.37 0 0 1 8 4.02c.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.95.08 2.16.51.57.82 1.3.82 2.19 0 3.13-1.87 3.82-3.65 4.03.29.26.54.75.54 1.52 0 1.09-.01 1.97-.01 2.24 0 .21.15.47.55.39A8.1 8.1 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z" />
                    </svg>
                    Continue with GitHub
                  </Link>
                )}
              </div>

              <label className="field-label" htmlFor="oz-product-url">Product URL</label>
              <div className="oz-url-row">
                <Input id="oz-product-url" className="oz-url-input" value={productUrl} onChange={(e) => setProductUrl(e.target.value)} placeholder="https://yourproduct.com" />
                <Button disabled={busy || !productUrl.trim()} onClick={startJob}>
                  {busy ? "Starting..." : "Start Oz"}
                </Button>
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
                <Link href="/evals/new" className={buttonClassName({ variant: "outline" })}>Open Manual Builder</Link>
              </div>
              {authRequired && (
                <div className="oz-auth-error">
                  <span>GitHub sign-in is required before Oz can create a job.</span>
                  <Link className={buttonClassName({ className: "github-btn" })} href="/auth/github?returnTo=/oz">Continue with GitHub</Link>
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
          {job.status === "running" && (
            <Button
              variant="outline"
              disabled={busy}
              title="Cancel queued work and stop any active sandbox VM for this run."
              onClick={stopJob}
            >
              {busy ? "Stopping..." : "Stop run"}
            </Button>
          )}
          {job.status === "running" && (
            <Button
              variant="destructive"
              disabled={busy}
              title="Stop active sandbox VMs, cancel queued work, and delete this job's run records."
              onClick={() => void deleteJob("TERMINATE")}
            >
              Terminate & clean up
            </Button>
          )}
          {job.status !== "running" && (
            <Button
              variant="ghost"
              className="danger-text"
              disabled={busy}
              title="Delete this saved job record and its run data."
              onClick={() => void deleteJob("DELETE")}
            >
              Delete record
            </Button>
          )}
          <Link className={buttonClassName({ variant: "outline" })} href="/oz">New Oz Job</Link>
        </div>
      </div>

      <section className="oz-status-board">
        <Card className="oz-stat-card">
          <CardContent>
          <span>Phase</span>
          <strong>{phaseLabel(job.status)}</strong>
          </CardContent>
        </Card>
        <Card className="oz-stat-card">
          <CardContent>
          <span>Docs</span>
          <strong>{docsCount}</strong>
          </CardContent>
        </Card>
        <Card className="oz-stat-card">
          <CardContent>
          <span>Scenarios</span>
          <strong>{scenarioCount}</strong>
          </CardContent>
        </Card>
        <Card className="oz-stat-card">
          <CardContent>
          <span>Research</span>
          <strong>{researchConflictCount}</strong>
          </CardContent>
        </Card>
        <Card className="oz-stat-card">
          <CardContent>
          <span>Runs</span>
          <strong>{runCount}</strong>
          </CardContent>
        </Card>
        <Card className="oz-stat-card">
          <CardContent>
          <span>Secrets</span>
          <strong>{requiredSecrets}</strong>
          </CardContent>
        </Card>
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

      <div className="oz-workspace">
        <main className="oz-primary-column">
          <section className="oz-now">
            <div>
              <p className="eyebrow">Current signal</p>
              <strong>{latestDisplayEvent ? latestDisplayEvent.title : "Waiting for activity"}</strong>
              <span title={latestDisplayEvent?.rawMessage}>{latestDisplayEvent ? latestDisplayEvent.message : "Oz will stream discovery, suite, and run events here."}</span>
            </div>
          </section>

          <section className="oz-timeline">
            <div className="oz-timeline-title">
              <div>
                <p className="eyebrow">Live activity</p>
                <strong>Run console</strong>
              </div>
              <div className="oz-feed-meta">
                <span>{events.length} raw event{events.length === 1 ? "" : "s"}</span>
                <span>{displayEvents.length} signal{displayEvents.length === 1 ? "" : "s"}</span>
              </div>
            </div>
            <div className="oz-event-filters" aria-label="Live event filters">
              {EVENT_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  className={`oz-filter-chip${eventFilter === filter.id ? " active" : ""}`}
                  onClick={() => setEventFilter(filter.id)}
                  type="button"
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="oz-feed-shell">
              <div className="oz-feed-list" ref={feedRef} onScroll={handleFeedScroll}>
                {filteredDisplayEvents.length === 0 && (
                  <div className="oz-empty-events">
                    <strong>No matching events</strong>
                    <p>Change the filter or wait for Oz to stream discovery, approval, run, and report events.</p>
                  </div>
                )}
                {filteredDisplayEvents.map((event) => (
                  <article key={event.id} className={`oz-event ${event.tone}${event.isReasoning ? " reasoning" : ""}`}>
                    <span className="oz-event-dot" />
                    <div>
                      <div className="oz-event-line">
                        <strong>{event.title}</strong>
                        {event.timeLabel ? <time>{event.timeLabel}</time> : null}
                        {event.count > 1 ? <span>{event.count} updates</span> : null}
                      </div>
                      <p title={event.rawMessage}>{event.message}</p>
                      {event.rawEvents.length > 1 && (
                        <details className="oz-event-details">
                          <summary>Raw telemetry</summary>
                          <pre>{event.rawEvents.slice(-3).map((raw) => raw.message).join("\n")}</pre>
                        </details>
                      )}
                    </div>
                  </article>
                ))}
              </div>
              {!autoFollowFeed && pendingFeedUpdates > 0 && (
                <button className="oz-new-updates" onClick={() => scrollFeedToLatest()} type="button">
                  {pendingFeedUpdates} new update{pendingFeedUpdates === 1 ? "" : "s"}
                </button>
              )}
            </div>
          </section>
        </main>

        <aside className="oz-side-rail">
          {job?.state.productProfile && (
            <section className="oz-panel">
              <div className="oz-panel-header">
                <h2>Product profile</h2>
                <Badge variant="outline">{confidence(job.state.productProfile.confidence)}</Badge>
              </div>
              <div className="oz-intel-grid compact">
                <p><strong>Product:</strong> {job.state.productProfile.productName}</p>
                <p><strong>Type:</strong> {job.state.productProfile.productType.join(", ")}</p>
                <p><strong>Auth:</strong> {job.state.productProfile.auth?.scheme ?? "unknown"}</p>
                <p><strong>SDKs:</strong> {job.state.productProfile.sdks.map((sdk) => sdk.packageName).join(", ") || "none found"}</p>
                <p><strong>Required env:</strong> {job.state.productProfile.requiredEnv.map((env) => env.name).join(", ") || "none detected"}</p>
              </div>
              <p className="oz-summary">{job.state.productProfile.summary}</p>
            </section>
          )}

          {research && (
            <section className="oz-panel">
              <div className="oz-panel-header">
                <h2>Research</h2>
                <Badge variant={research.conflicts.length ? "warning" : "success"}>
                  {research.conflicts.length ? `${research.conflicts.length} conflicts` : "clean"}
                </Badge>
              </div>
              <div className="oz-research-summary">
                <div><strong>{research.checkedSources.length}</strong><span>sources checked</span></div>
                <div><strong>{research.claims.length}</strong><span>claims extracted</span></div>
              </div>
              {research.conflicts.slice(0, 3).map((conflict) => (
                <div className="oz-research-mini" key={conflict.id}>
                  <strong>{conflict.title}</strong>
                  <span>{insightLabel(conflict.status)} · {insightLabel(conflict.category)} · {confidence(conflict.confidence)}</span>
                </div>
              ))}
            </section>
          )}

          {job?.state.productProfile?.requiredEnv.length ? (
            <section className="oz-panel">
              <div className="oz-panel-header">
                <h2>Credentials</h2>
                <Badge variant={missingSecrets.length ? "warning" : "success"}>{missingSecrets.length ? `${missingSecrets.length} missing` : "ready"}</Badge>
              </div>
              <div className="secret-list">
                {job.state.productProfile.requiredEnv.map((env) => {
                  const saved = savedSecretNames.has(env.name);
                  const missing = missingSecrets.includes(env.name);
                  return (
                    <div className="secret-row" key={env.name}>
                      <div>
                        <strong className="mono">{env.name}</strong>
                        <span>{env.required === false ? "optional" : "required"} · {saved ? "saved" : missing ? "missing" : "available from environment"}</span>
                      </div>
                      <Input
                        className="inline-input mono"
                        type="password"
                        value={secretInputs[env.name] ?? ""}
                        placeholder={saved ? "Saved value" : "Paste value"}
                        onChange={(e) => setSecretInputs((current) => ({ ...current, [env.name]: e.target.value }))}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="oz-card-actions">
                <Button disabled={busy || Object.keys(secretInputs).length === 0} onClick={() => void saveSecrets()}>
                  {busy ? "Saving..." : "Save credentials"}
                </Button>
              </div>
            </section>
          ) : null}

          {currentRunBlockers.length > 0 && (
            <section className="oz-panel">
              <div className="oz-panel-header">
                <h2>Blockers</h2>
                <Badge variant="warning">{currentRunBlockers.length}</Badge>
              </div>
              <div className="oz-run-blockers">
                {currentRunBlockers.map((blocker) => <span key={blocker}>{blocker}</span>)}
              </div>
            </section>
          )}

          {draftSuite && (
            <section className="oz-panel">
              <div className="oz-panel-header">
                <h2>Suite summary</h2>
                <Badge variant="secondary">{draftSuite.scenarios.length} scenarios</Badge>
              </div>
              <div className="oz-suite-summary-list">
                {draftSuite.scenarios.slice(0, 4).map((scenario) => (
                  <div key={scenario.id}>
                    <strong>{scenario.title}</strong>
                    <span>{scenario.assertions.length} checks · {confidence(scenario.confidence)}</span>
                  </div>
                ))}
              </div>
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
        </aside>
      </div>

      {draftSuite && (
        <section className="oz-panel">
          <div className="oz-panel-header">
            <h2>Editable test suite</h2>
            <Badge variant="secondary">{draftSuite.scenarios.length} scenarios</Badge>
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
                      <Button onClick={saveSuite}>Save</Button>
                      <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
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
              <Button disabled={!canRunSuite} onClick={() => post("/run", { agentType: "claude-code", requestedRuns: 1 })}>
                {busy ? "Working..." : "Run test suite"}
              </Button>
            </div>
          )}
        </section>
      )}

      {research && (
        <section className="oz-panel">
          <div className="oz-panel-header">
            <div>
              <h2>Research claim consistency</h2>
              <p className="oz-summary">Oz compares docs, repositories, registries, package metadata, and SDK declarations before agents run.</p>
            </div>
            <Badge variant={research.conflicts.length ? "warning" : "success"}>
              {research.conflicts.length ? `${research.conflicts.length} issue${research.conflicts.length === 1 ? "" : "s"}` : "no conflicts"}
            </Badge>
          </div>
          <div className="oz-research-summary wide">
            <div><strong>{research.checkedSources.length}</strong><span>checked sources</span></div>
            <div><strong>{research.claims.length}</strong><span>claims</span></div>
            <div><strong>{research.conflicts.filter((item) => item.status === "confirmed").length}</strong><span>confirmed</span></div>
            <div><strong>{research.conflicts.filter((item) => item.status === "suspected").length}</strong><span>suspected</span></div>
          </div>
          {research.conflicts.length > 0 ? (
            <div className="oz-research-conflicts">
              {research.conflicts.map((conflict) => (
                <article className={`oz-research-conflict ${conflict.status}`} key={conflict.id}>
                  <div className="oz-friction-title">
                    <div>
                      <span>{insightLabel(conflict.category)}</span>
                      <strong>{conflict.title}</strong>
                    </div>
                    <span className={`badge ${conflict.severity}`}>{insightLabel(conflict.status)} · {confidence(conflict.confidence)}</span>
                  </div>
                  <p>{conflict.recommendation}</p>
                  <div className="oz-claim-grid">
                    {conflict.claims.slice(0, 6).map((claim) => (
                      <div className="oz-claim-card" key={claim.id}>
                        <span>{claim.sourceType} · {claim.kind}</span>
                        <strong>{claim.value}</strong>
                        <p>{claim.evidence.source}: {claim.evidence.quote}</p>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="oz-empty-events">
              <strong>No cross-source conflicts detected</strong>
              <p>Oz still records the checked sources and extracted claims so future docs or package changes can be compared.</p>
            </div>
          )}
          {research.checkedSources.length > 0 && (
            <details className="oz-source-list">
              <summary>Checked sources</summary>
              <div>
                {research.checkedSources.slice(0, 24).map((source) => (
                  <a key={source} href={source.startsWith("http") ? source : undefined} target="_blank" rel="noreferrer">{source}</a>
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      {job?.state.run?.runIds.length ? (
        <section className="oz-panel">
          <div className="oz-panel-header">
            <h2>{job.status === "stopped" ? "Stopped run" : job.status === "complete" ? "Run reports" : "Live run"}</h2>
            <Badge variant="secondary">{job.state.run.runIds.length} run{job.state.run.runIds.length === 1 ? "" : "s"}</Badge>
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
              <Link key={runId} className={buttonClassName({ variant: "outline", size: "sm" })} href={`/reports/${runId}`}>Report {runId.slice(0, 8)}</Link>
            ))}
          </div>
        </section>
      ) : null}

      {job?.state.report && (
        <section className="oz-panel">
          <div className="oz-panel-header">
            <h2>Final DX report</h2>
            <Badge variant="secondary">{(job.state.report.frictionInsights ?? []).length} insight{(job.state.report.frictionInsights ?? []).length === 1 ? "" : "s"}</Badge>
          </div>
          <p className="oz-summary">{job.state.report.summary}</p>
          <div className="oz-behavior-grid">
            <div><strong>{job.state.report.behaviorSummary?.passedRuns ?? 0}/{job.state.report.behaviorSummary?.totalRuns ?? 0}</strong><span>passed</span></div>
            <div><strong>{job.state.report.behaviorSummary?.retrySignals ?? 0}</strong><span>retry signals</span></div>
            <div><strong>{job.state.report.behaviorSummary?.apiErrorSignals ?? 0}</strong><span>API errors</span></div>
            <div><strong>{job.state.report.behaviorSummary?.platformSignals ?? 0}</strong><span>platform signals</span></div>
          </div>
          {(job.state.report.frictionInsights ?? []).length > 0 && (
            <div className="oz-friction-list">
              {(job.state.report.frictionInsights ?? []).map((insight) => (
                <article className={`oz-friction-card ${insight.status}`} key={insight.id}>
                  <div className="oz-friction-title">
                    <div>
                      <span>{insightLabel(insight.category)}</span>
                      <strong>{insight.title}</strong>
                    </div>
                    <span className={`badge ${insight.severity}`}>{insightLabel(insight.status)} · {confidence(insight.confidence)}</span>
                  </div>
                  <p>{insight.behavior}</p>
                  <p><strong>Fix:</strong> {insight.recommendation}</p>
                  <div className="oz-evidence-grid">
                    <div>
                      <strong>Trace evidence</strong>
                      {insight.traceEvidence.slice(0, 2).map((item) => (
                        <p key={`${insight.id}-trace-${item.source}`}>{item.quote}</p>
                      ))}
                    </div>
                    <div>
                      <strong>Docs evidence</strong>
                      {insight.docsEvidence.slice(0, 2).map((item) => (
                        <p key={`${insight.id}-docs-${item.source}`}>{item.source}: {item.quote}</p>
                      ))}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
          <div className="oz-fix-list">
            <h3>Recommended fixes</h3>
            {job.state.report.recommendedFixes.map((fix, index) => (
              <div className="finding-row" key={`${fix.title}-${index}`}>
                <strong>{fix.title}</strong>
                <p>{fix.detail}</p>
              </div>
            ))}
          </div>
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
