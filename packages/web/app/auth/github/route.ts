import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export async function GET(req: Request): Promise<Response> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  if (!clientId) {
    return NextResponse.redirect(new URL("/", appUrl));
  }

  const state = randomUUID();
  const cookieBase = {
    httpOnly: true,
    sameSite: "lax",
    secure: appUrl.startsWith("https://"),
    path: "/",
    maxAge: 600,
  } as const;

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${appUrl}/auth/github/callback`);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url);
  response.cookies.set("kiln_oauth_state", state, cookieBase);
  response.cookies.set("kiln_oauth_return_to", safeReturnTo(new URL(req.url).searchParams.get("returnTo")), cookieBase);
  return response;
}
