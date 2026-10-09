import "server-only";
import { pool, run, type Queryable } from "@/lib/db/sql";

export interface AuditEntry {
  userId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Writes an audit row. Pass a transaction so the entry commits atomically with the change. */
export async function writeAudit(db: Queryable, entry: AuditEntry) {
  await run(
    db,
    "INSERT INTO audit_logs (user_id, action, entity_type, entity_id, metadata) VALUES (?, ?, ?, ?, CAST(? AS JSON))",
    [
      entry.userId ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}

/** Best-effort audit write from app code (failures are logged, never thrown). */
export async function audit(action: string, options: Omit<AuditEntry, "action"> = {}) {
  try {
    await writeAudit(pool(), { action, ...options });
  } catch (error) {
    console.error("[audit]", action, error);
  }
}

