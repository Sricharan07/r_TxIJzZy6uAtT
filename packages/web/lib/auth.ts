import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { User } from "@kiln/shared";
import { getStore } from "@kiln/shared/store";

const SESSION_COOKIE = "kiln_session";
const LEGACY_SESSION_COOKIE = "id";
const SESSION_TTL_SEC = 60 * 60 * 24 * 30;

function requireGitHubAuth(): boolean {
  return process.env.KILN_REQUIRE_AUTH === "1" || process.env.NODE_ENV === "production";
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

function cookieOptions() {
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

export async function createUserSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1_000).toISOString();
  await getStore().createSession(hashSessionToken(token), userId, expiresAt);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, cookieOptions());
  cookieStore.set(LEGACY_SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
}

export async function clearCurrentSession(): Promise<void> {
  const cookieStore = await cookies();
  const tokens = [cookieStore.get(SESSION_COOKIE)?.value, cookieStore.get(LEGACY_SESSION_COOKIE)?.value].filter(Boolean);
  await Promise.all(tokens.map((token) => getStore().deleteSession(hashSessionToken(token!))));
  cookieStore.set(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
  cookieStore.set(LEGACY_SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
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
