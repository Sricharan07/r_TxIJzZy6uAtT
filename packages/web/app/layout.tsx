import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "../components/Nav";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
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
              Free plan — <strong>first 10 evals</strong> each month
            </span>
          </div>
          <Nav />
          {children}
        </div>
      </body>
    </html>
  );
}
