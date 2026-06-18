import { redirect } from "next/navigation";
import { clearCurrentSession } from "../../../lib/auth";

export const runtime = "nodejs";

export async function GET(): Promise<void> {
  await clearCurrentSession();
  redirect("/");
}
