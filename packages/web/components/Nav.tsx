"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/evals/new", label: "New Eval", match: (p: string) => p.startsWith("/evals") },
  { href: "/", label: "Onboarding", match: (p: string) => p === "/" },
];

/** Sticky top nav (Decision 8 — GitHub user avatar; Decision 12 — brand mark). */
export function Nav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="nav">
      <Link href="/" className="nav-brand">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect width="24" height="24" rx="6" fill="#2563eb" />
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
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={`nav-link${l.match(pathname) ? " active" : ""}`}
          >
            {l.label}
          </Link>
        ))}
        <Link className="nav-user" title="Sign in with GitHub" href="/auth/github">
          GH
        </Link>
      </div>
    </nav>
  );
}
