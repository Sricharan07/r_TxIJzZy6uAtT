/**
 * GET /auth/github/callback — finish the GitHub OAuth flow (Decision 8).
 *
 * Exchanges the `code` for an access token, fetches the GitHub user, stores a
 * session cookie, and redirects home. When credentials are not configured (or
 * `?dev=1` is present) it sets a deterministic dev session instead, so the flow
 * works end-to-end in this sandbox without a real OAuth app.
 */
import { cookies } from "next/headers";
import { SESSION_COOKIE, encodeSession, type Session } from "../../../../lib/session";

export const runtime = "nodejs";

function setSession(session: Session): void {
  cookies().set(SESSION_COOKIE, encodeSession(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const home = new URL("/", req.url).toString();
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const isDev = url.searchParams.get("dev") === "1" || !clientId || !clientSecret;

  // DEV FALLBACK: no real OAuth app configured — sign in a placeholder user.
  if (isDev) {
    setSession({ login: "devuser", avatarUrl: "", githubId: 0 });
    return Response.redirect(home, 302);
  }

  const code = url.searchParams.get("code");
  if (!code) return Response.redirect(new URL("/?auth_error=1", req.url).toString(), 302);

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const tokenJson = (await tokenRes.json()) as { access_token?: string };
    const accessToken = tokenJson.access_token;
    if (!accessToken) return Response.redirect(new URL("/?auth_error=1", req.url).toString(), 302);

    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "kiln",
        Accept: "application/vnd.github+json",
      },
    });
    const user = (await userRes.json()) as { login?: string; id?: number; avatar_url?: string };
    if (!user.login || typeof user.id !== "number") {
      return Response.redirect(new URL("/?auth_error=1", req.url).toString(), 302);
    }

    setSession({ login: user.login, avatarUrl: user.avatar_url ?? "", githubId: user.id });
    return Response.redirect(home, 302);
  } catch {
    return Response.redirect(new URL("/?auth_error=1", req.url).toString(), 302);
  }
}
