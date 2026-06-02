import Link from "next/link";
import { SignIn } from "../components/SignIn";

const STEPS = [
  {
    title: "Define a task",
    body: 'Describe a realistic integration task — "Build a checkout flow using our Payments SDK."',
  },
  {
    title: "Add your context",
    body: "Link your docs, SDK repo, or upload example files. This is what the agent sees.",
  },
  {
    title: "Set pass/fail tests",
    body: "Define assertions: HTTP checks, file existence, shell commands, or LLM-judged criteria.",
  },
  {
    title: "Get your report",
    body: "We run the agent in an isolated sandbox, grade the output, and give you a shareable report URL showing exactly where the agent succeeded or failed.",
  },
];

/** Onboarding walkthrough — the post-OAuth landing (Decision 14). */
export default function OnboardingPage() {
  return (
    <div className="onboarding">
      <h1>Welcome to Kiln</h1>
      <p className="subtitle">
        Test whether coding agents can successfully integrate your API. Run real
        agents, grade the results, see exactly where they fail.
      </p>

      <div style={{ display: "flex", justifyContent: "center", marginBottom: "32px" }}>
        <SignIn />
      </div>

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
        href="/evals/new"
        className="btn btn-primary"
        style={{ padding: "12px 32px", fontSize: "14px" }}
      >
        Create Your First Eval →
      </Link>
      <p style={{ fontSize: "12px", color: "var(--text-dim)", marginTop: "12px" }}>
        Free plan — 10 evals/month, no credit card required
      </p>
    </div>
  );
}
