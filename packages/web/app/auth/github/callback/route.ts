import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getStore } from "@kiln/shared/store";
import type { User } from "@kiln/shared";
import { createUserSession } from "../../../../lib/auth";

export const runtime = "nodejs";

interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
}

async function exchangeCode(code: string, appUrl: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${appUrl}/auth/github/callback`,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) throw new Error(data.error ?? "GitHub token exchange failed");
  return data.access_token;
}

async function fetchGitHubUser(token: string): Promise<GitHubUser> {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error("GitHub user request failed");
  return (await res.json()) as GitHubUser;
}

export async function GET(req: Request): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieStore = await cookies();
  const expectedState = cookieStore.get("kiln_oauth_state")?.value;

  if (!code || !state || state !== expectedState) {
    redirect("/");
  }

  const token = await exchangeCode(code, appUrl);
  const ghUser = await fetchGitHubUser(token);
  const user: User = {
    id: `gh_${ghUser.id}`,
    githubId: ghUser.id,
    login: ghUser.login,
    avatarUrl: ghUser.avatar_url,
    createdAt: new Date().toISOString(),
  };
  const storedUser = await getStore().upsertUser(user);

  await createUserSession(storedUser.id);
  cookieStore.set("kiln_oauth_state", "", {
    httpOnly: true,
    sameSite: "lax",
    secure: appUrl.startsWith("https://"),
    path: "/",
    maxAge: 0,
  });
  redirect("/");
}
