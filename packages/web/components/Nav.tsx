import Link from "next/link";
import { currentUser } from "../lib/auth";

const LINKS = [
  { href: "/oz", label: "Oz Agent" },
  { href: "/evals/new", label: "Manual" },
  { href: "/", label: "Onboarding" },
];

/** Sticky top nav (Decision 8 - GitHub user avatar; Decision 12 - brand mark). */
export async function Nav() {
  const user = await currentUser();
  return (
    <nav className="nav">
      <Link href="/" className="nav-brand">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect width="24" height="24" rx="6" fill="#667044" />
          <path
            d="M7 12l3 3 7-7"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Kiln
      </Link>
      <div className="nav-links">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="nav-link">
            {link.label}
          </Link>
        ))}
        {user ? (
          <div className="nav-user">
            {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span className="nav-avatar-fallback">{user.login.slice(0, 1).toUpperCase()}</span>}
            <span>{user.login}</span>
            <form className="nav-signout-form" action="/auth/signout" method="post">
              <button className="nav-signout" type="submit">Sign out</button>
            </form>
          </div>
        ) : (
          <Link className="nav-signin" title="Sign in with GitHub" href="/auth/github?returnTo=/oz">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M8 0C3.58 0 0 3.67 0 8.2c0 3.62 2.29 6.69 5.47 7.78.4.08.55-.18.55-.39 0-.19-.01-.84-.01-1.52-2.01.38-2.53-.5-2.69-.96-.09-.24-.48-.96-.82-1.15-.28-.16-.68-.55-.01-.56.63-.01 1.08.59 1.23.84.72 1.24 1.87.89 2.33.68.07-.53.28-.89.51-1.09-1.78-.21-3.64-.91-3.64-4.03 0-.89.31-1.62.82-2.19-.08-.21-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.37 7.37 0 0 1 8 4.02c.68 0 1.36.09 2 .27 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.95.08 2.16.51.57.82 1.3.82 2.19 0 3.13-1.87 3.82-3.65 4.03.29.26.54.75.54 1.52 0 1.09-.01 1.97-.01 2.24 0 .21.15.47.55.39A8.1 8.1 0 0 0 16 8.2C16 3.67 12.42 0 8 0Z" />
            </svg>
            <span>Sign in</span>
          </Link>
        )}
      </div>
    </nav>
  );
}
