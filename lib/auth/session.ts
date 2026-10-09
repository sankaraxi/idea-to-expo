import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { AppError } from "@/lib/errors";
import { createSession, destroySession, resolveSession, type SessionUser } from "@/lib/services/auth";
import { SESSION_COOKIE } from "./session-cookie";

export type { SessionUser };

/**
 * Data Access Layer entry point: validates the session cookie against the
 * database on every request (deduplicated per request). Authorization is
 * enforced here and in the services — there is no database-level row security,
 * so every evaluator query is scoped by the evaluatorId derived from this
 * session, never from request input.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return resolveSession(token);
});

/** Creates a session for the user and sets the cookie (call from a Server Action). */
export async function startSession(userId: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const { token } = await createSession(userId, meta);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // No Max-Age: a browser-session cookie. The server-side expiry (12 h, sliding) is the real limit.
  });
}

export async function endSession() {
  const store = await cookies();
  await destroySession(store.get(SESSION_COOKIE)?.value);
  store.delete(SESSION_COOKIE);
}

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
