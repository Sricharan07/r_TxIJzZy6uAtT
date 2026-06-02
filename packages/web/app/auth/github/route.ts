/**
 * GET /auth/github — start the GitHub OAuth flow (Decision 8).
 *
 * PRODUCTION: redirects to GitHub's authorize endpoint. The user approves and
 * GitHub calls back to /auth/github/callback with a `code`.
 *
 * DEV/SANDBOX: when GITHUB_CLIENT_ID is not configured, we skip straight to the
 * callback with `?dev=1` so the sign-in flow is fully exercisable locally
 * without registering an OAuth app. Set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET
 * to activate the real flow.
 */
export const runtime = "nodejs";

export function GET(req: Request): Response {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const redirectUri = new URL("/auth/github/callback", req.url).toString();

  if (!clientId) {
    const devCallback = new URL("/auth/github/callback", req.url);
    devCallback.searchParams.set("dev", "1");
    return Response.redirect(devCallback.toString(), 302);
  }

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", "kiln");
  return Response.redirect(authorize.toString(), 302);
}
