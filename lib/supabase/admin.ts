import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertPublicEnv, serverEnv } from "@/lib/env";
import type { Database } from "@/types/database";

export type AdminClient = SupabaseClient<Database>;

let cached: AdminClient | null = null;

/**
 * Service-role client. Bypasses RLS — only call after the caller has been
 * authorised server-side (requireAdmin) or from secret-protected workers.
 * Never import from client components (`server-only` enforces this).
 */
export function createAdminClient(): AdminClient {
  if (cached) return cached;
  const { supabaseUrl } = assertPublicEnv();
  cached = createClient<Database>(supabaseUrl, serverEnv().SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
