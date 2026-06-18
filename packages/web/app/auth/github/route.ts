import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const runtime = "nodejs";

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export async function GET(req: Request): Promise<void> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  if (!clientId) {
    redirect("/");
  }

  const state = randomUUID();
  const cookieStore = await cookies();
  const cookieBase = {
    httpOnly: true,
    sameSite: "lax",
    secure: appUrl.startsWith("https://"),
    path: "/",
    maxAge: 600,
  } as const;
  cookieStore.set("kiln_oauth_state", state, cookieBase);
  cookieStore.set("kiln_oauth_return_to", safeReturnTo(new URL(req.url).searchParams.get("returnTo")), cookieBase);

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${appUrl}/auth/github/callback`);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  redirect(url.toString());
}
