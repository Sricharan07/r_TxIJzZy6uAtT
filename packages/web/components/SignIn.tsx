import { getSession } from "../lib/session";

function initials(login: string): string {
  return login.slice(0, 2).toUpperCase();
}

/** Sign-in CTA / signed-in indicator (Decision 8). Server component. */
export function SignIn() {
  const session = getSession();
  if (session) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <span className="nav-user">{initials(session.login)}</span>
        <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
          Signed in as @{session.login}
        </span>
      </div>
    );
  }
  return (
    <a className="btn btn-primary" href="/auth/github">
      Sign in with GitHub
    </a>
  );
}
