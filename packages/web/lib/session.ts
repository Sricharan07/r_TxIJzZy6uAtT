/**
 * Session helpers for GitHub OAuth (Decision 8).
 *
 * The session is a small signed-ish payload stored in an httpOnly cookie. For
 * the MVP it is a base64url-encoded JSON blob (no secret signing yet — that is
 * a clearly-marked follow-up); it is enough to identify the signed-in GitHub
 * user for eval creation. Reports remain publicly viewable without a session.
 */
import { cookies } from "next/headers";

export const SESSION_COOKIE = "kiln_session";

export interface Session {
  login: string;
  avatarUrl: string;
  githubId: number;
}

export function encodeSession(s: Session): string {
  return Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
}

export function decodeSession(value: string): Session | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed &&
      typeof parsed.login === "string" &&
      typeof parsed.avatarUrl === "string" &&
      typeof parsed.githubId === "number"
    ) {
      return parsed as Session;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read the current session from the request cookies (server-only). */
export function getSession(): Session | null {
  const raw = cookies().get(SESSION_COOKIE)?.value;
  return raw ? decodeSession(raw) : null;
}
