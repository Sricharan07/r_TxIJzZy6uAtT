import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { User } from "@kiln/shared";
import { getStore } from "@kiln/shared/store";

export const SESSION_COOKIE = "kiln_session";
export const LEGACY_SESSION_COOKIE = "id";
const SESSION_TTL_SEC = 60 * 60 * 24 * 30;

function requireGitHubAuth(): boolean {
  return process.env.KILN_REQUIRE_AUTH === "1" || process.env.NODE_ENV === "production";
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: appUrl().startsWith("https://"),
    path: "/",
    maxAge: SESSION_TTL_SEC,
  };
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function expiredSessionCookieOptions() {
  return { ...sessionCookieOptions(), maxAge: 0 };
}

export async function createSessionToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1_000).toISOString();
  await getStore().createSession(hashSessionToken(token), userId, expiresAt);
  return token;
}

export async function deleteSessionTokens(tokens: Array<string | undefined>): Promise<void> {
  const activeTokens = tokens.filter((token): token is string => Boolean(token));
  await Promise.all(activeTokens.map((token) => getStore().deleteSession(hashSessionToken(token))));
}

export async function createUserSession(userId: string): Promise<void> {
  const token = await createSessionToken(userId);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, sessionCookieOptions());
  cookieStore.set(LEGACY_SESSION_COOKIE, "", expiredSessionCookieOptions());
}

export async function clearCurrentSession(): Promise<void> {
  const cookieStore = await cookies();
  await deleteSessionTokens([cookieStore.get(SESSION_COOKIE)?.value, cookieStore.get(LEGACY_SESSION_COOKIE)?.value]);
  cookieStore.set(SESSION_COOKIE, "", expiredSessionCookieOptions());
  cookieStore.set(LEGACY_SESSION_COOKIE, "", expiredSessionCookieOptions());
}

/** Return the authenticated user, or a seeded identity only in local development. */
export async function currentUserId(): Promise<string | null> {
  return (await currentUser())?.id ?? null;
}

export async function currentUser(): Promise<User | null> {
  const store = getStore();
  const sessionToken = (await cookies()).get(SESSION_COOKIE)?.value;
  if (sessionToken) {
    const userId = await store.getSessionUserId(hashSessionToken(sessionToken));
    const user = userId ? await store.getUser(userId) : null;
    if (user) return user;
  }
  if (requireGitHubAuth()) return null;
  return store.getOrCreateDevUser();
}
