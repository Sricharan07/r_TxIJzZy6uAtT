import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  deleteSessionTokens,
  expiredSessionCookieOptions,
  LEGACY_SESSION_COOKIE,
  SESSION_COOKIE,
} from "../../../lib/auth";

export const runtime = "nodejs";

function homeRedirect(): NextResponse {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return NextResponse.redirect(new URL("/", appUrl));
}

export async function GET(): Promise<Response> {
  return homeRedirect();
}

export async function POST(): Promise<Response> {
  const cookieStore = await cookies();
  await deleteSessionTokens([cookieStore.get(SESSION_COOKIE)?.value, cookieStore.get(LEGACY_SESSION_COOKIE)?.value]);
  const response = homeRedirect();
  response.cookies.set(SESSION_COOKIE, "", expiredSessionCookieOptions());
  response.cookies.set(LEGACY_SESSION_COOKIE, "", expiredSessionCookieOptions());
  return response;
}
