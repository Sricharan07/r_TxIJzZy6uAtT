import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "../components/Nav";

export const metadata: Metadata = {
  title: "Kiln — Agent Integration Eval Platform",
  description:
    "Test whether coding agents can successfully integrate your API. Run real agents, grade the results, see exactly where they fail.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-wrapper">
          {/* Free-tier usage banner (Decision 20) */}
          <div className="free-banner">
            <span>
              Free plan — <strong>7 of 10</strong> evals remaining this month
            </span>
          </div>
          <Nav />
          {children}
        </div>
      </body>
    </html>
  );
}
