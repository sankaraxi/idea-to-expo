"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { endSession, startSession } from "@/lib/auth/session";
import { fail, toFailure, type ActionResult } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/services/audit";
import { authenticate } from "@/lib/services/auth";
import { loginSchema } from "@/lib/validation/schemas";

export async function login(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = loginSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return fail("VALIDATION", "Enter your email and password.");

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateLimit(`login:${ip}`, 20, 60_000) || !rateLimit(`login:${parsed.data.email}`, 8, 60_000)) {
    return fail("RATE_LIMITED");
  }

  let role: "ADMIN" | "EVALUATOR";
  try {
    const user = await authenticate(parsed.data.email, parsed.data.password);
    // Same message for unknown email / wrong password / disabled account.
    if (!user) return fail("VALIDATION", "Invalid email or password, or your account is disabled.");
    role = user.role;
    await startSession(user.id, { ip, userAgent: h.get("user-agent") });
    await audit(role === "ADMIN" ? "ADMIN_LOGIN" : "EVALUATOR_LOGIN", {
      userId: user.id,
      entityType: "user",
      entityId: user.id,
      metadata: { ip },
    });
  } catch (error) {
    return toFailure(error, "login");
  }

  const next = String(formData.get("next") ?? "");
  const home = role === "ADMIN" ? "/admin" : "/evaluator";
  redirect(next.startsWith(home) ? next : home);
}

export async function logout() {
  await endSession();
  redirect("/login");
}
