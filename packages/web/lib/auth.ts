import { cookies } from "next/headers";
import { getStore } from "@kiln/shared/store";

function requireGitHubAuth(): boolean {
  return process.env.KILN_REQUIRE_AUTH === "1" || process.env.NODE_ENV === "production";
}

/** Return the authenticated user, or a seeded identity only in local development. */
export async function currentUserId(): Promise<string | null> {
  const store = getStore();
  const cookieUser = (await cookies()).get("kiln_user")?.value;
  if (cookieUser && (await store.getUser(cookieUser))) return cookieUser;
  if (requireGitHubAuth()) return null;
  return (await store.getOrCreateDevUser()).id;
}
