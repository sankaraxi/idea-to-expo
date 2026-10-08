"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { fail, type ActionResult } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { loginSchema } from "@/lib/validation/schemas";

export async function login(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const parsed = loginSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return fail("VALIDATION", "Enter your email and password.");

  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateLimit(`login:${ip}`, 20, 60_000) || !rateLimit(`login:${parsed.data.email}`, 8, 60_000)) {
    return fail("RATE_LIMITED");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error || !data.user) {
    // Same message for unknown email / wrong password / banned (disabled) account.
    return fail("VALIDATION", "Invalid email or password, or your account is disabled.");
  }

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  if (!profile) {
    await supabase.auth.signOut();
    return fail("FORBIDDEN", "This account has no portal access. Contact the event admin.");
  }

  await audit(profile.role === "ADMIN" ? "ADMIN_LOGIN" : "EVALUATOR_LOGIN", {
    userId: data.user.id,
    entityType: "user",
    entityId: data.user.id,
    metadata: { ip },
  });

  const next = String(formData.get("next") ?? "");
  const home = profile.role === "ADMIN" ? "/admin" : "/evaluator";
  redirect(next.startsWith(home) ? next : home);
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
