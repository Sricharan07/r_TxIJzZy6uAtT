import Link from "next/link";

const STEPS = [
  {
    title: "Give Oz your product URL",
    body: "Oz discovers docs, SDKs, repos, auth pages, webhooks, examples, and changelogs.",
  },
  {
    title: "Review Product Intelligence",
    body: "Oz classifies your product, maps docs to integration surfaces, and cites evidence for every claim.",
  },
  {
    title: "Approve the generated suite",
    body: "Oz creates scenarios, deterministic assertions, safety checks, and repairs weak tests before you run.",
  },
  {
    title: "Get a DX report",
    body: "Oz watches the agent, diagnoses failures, and recommends docs, SDK, or environment fixes.",
  },
];

/** Onboarding walkthrough — the post-OAuth landing (Decision 14). */
export default function OnboardingPage() {
  return (
    <div className="onboarding">
      <h1>Welcome to Kiln</h1>
      <p className="subtitle">
        An agentic DX engineer that discovers your product, generates an
        agent-readiness suite, runs real agents, and explains exactly what to fix.
      </p>

      <div className="onboarding-steps">
        {STEPS.map((s, i) => (
          <div className="ob-step" key={s.title}>
            <div className="ob-step-num">{i + 1}</div>
            <div className="ob-step-content">
              <h4>{s.title}</h4>
              <p>{s.body}</p>
            </div>
          </div>
        ))}
      </div>

      <Link
        href="/oz"
        className="btn btn-primary"
        style={{ padding: "12px 32px", fontSize: "14px" }}
      >
        Start Oz
      </Link>
      <Link
        href="/evals/new"
        className="btn btn-ghost"
        style={{ padding: "12px 32px", fontSize: "14px", marginLeft: "8px" }}
      >
        Manual Builder
      </Link>
      <p style={{ fontSize: "12px", color: "var(--text-dim)", marginTop: "12px" }}>
        Free plan — 10 evals/month, no credit card required
      </p>
    </div>
  );
}
