import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/database";

/** Best-effort audit write from app code (DB functions audit their own actions). */
export async function audit(
  action: string,
  options: { userId?: string | null; entityType?: string; entityId?: string; metadata?: Record<string, unknown> } = {},
) {
  try {
    const { error } = await createAdminClient().from("audit_logs").insert({
      action,
      user_id: options.userId ?? null,
      entity_type: options.entityType ?? null,
      entity_id: options.entityId ?? null,
      metadata: (options.metadata ?? {}) as Json,
    });
    if (error) console.error("[audit]", action, error.message);
  } catch (error) {
    console.error("[audit]", action, error);
  }
}
