import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { AppError } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import type { AppRole } from "@/types/database";

export interface SessionUser {
  id: string;
  email: string;
  role: AppRole;
  name: string;
  /** Present for EVALUATOR users with an ACTIVE evaluator record. */
  evaluatorId: string | null;
}

/**
 * Data Access Layer entry point. Validates the session with Supabase Auth
 * (getUser, not getSession — the JWT is verified server-side) and loads the
 * role from the database. Deduplicated per request.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name, email")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return null;

  let evaluatorId: string | null = null;
  let name = profile.full_name ?? user.email ?? "User";
  if (profile.role === "EVALUATOR") {
    const { data: evaluator } = await supabase
      .from("evaluators")
      .select("id, name, status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (evaluator?.status === "ACTIVE") evaluatorId = evaluator.id;
    if (evaluator) name = evaluator.name;
  }

  return { id: user.id, email: user.email ?? profile.email ?? "", role: profile.role, name, evaluatorId };
});

export function homeFor(user: Pick<SessionUser, "role">) {
  return user.role === "ADMIN" ? "/admin" : "/evaluator";
}

/** For pages/layouts: redirects instead of throwing. */
export async function requireAdminPage(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect(homeFor(user));
  return user;
}

export async function requireEvaluatorPage(): Promise<SessionUser & { evaluatorId: string }> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "EVALUATOR") redirect(homeFor(user));
  if (!user.evaluatorId) redirect("/login?error=disabled");
  return user as SessionUser & { evaluatorId: string };
}

/** For server actions / route handlers: throws AppError (mapped to a safe message). */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AppError("UNAUTHENTICATED");
  if (user.role !== "ADMIN") throw new AppError("FORBIDDEN");
  return user;
}

export async function requireEvaluator(): Promise<SessionUser & { evaluatorId: string }> {
  const user = await getSessionUser();
  if (!user) throw new AppError("UNAUTHENTICATED");
  if (user.role !== "EVALUATOR" || !user.evaluatorId) throw new AppError("FORBIDDEN");
  return user as SessionUser & { evaluatorId: string };
}
