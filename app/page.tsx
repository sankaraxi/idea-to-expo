import { redirect } from "next/navigation";
import { getSessionUser, homeFor } from "@/lib/auth/session";

export default async function Home() {
  const user = await getSessionUser();
  redirect(user ? homeFor(user) : "/login");
}
