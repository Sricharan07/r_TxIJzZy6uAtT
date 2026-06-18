import OzClient from "./OzClient";
import { currentUser } from "../../lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function OzPage() {
  const user = await currentUser();
  return <OzClient user={user ? { login: user.login, avatarUrl: user.avatarUrl } : null} />;
}
