import "server-only";
import { AppError } from "@/lib/errors";
import { one, pool, run, withTransaction, type Queryable } from "@/lib/db/sql";
import type { AppSettingsRow, EventStatus, Json } from "@/types/database";
import { writeAudit } from "./audit";
import { enqueueFullResync, enqueueSync, RESULTS_KEY } from "./sync-queue";

export async function getSettingsRow(db: Queryable = pool()): Promise<AppSettingsRow> {
  const row = await one<AppSettingsRow>(db, "SELECT * FROM app_settings WHERE id = 1");
  if (!row) throw new Error("app_settings row is missing — import database/idea_to_expo.sql");
  return row;
}

const STATUSES: EventStatus[] = ["NOT_STARTED", "LIVE", "PAUSED", "CLOSED"];

export async function setEventStatus(adminId: string, status: string) {
  if (!STATUSES.includes(status as EventStatus)) throw new AppError("INVALID_EVENT_STATUS");
  await withTransaction(async (tx) => {
    const before = await one<{ event_status: EventStatus }>(tx, "SELECT event_status FROM app_settings WHERE id = 1 FOR UPDATE");
    await run(tx, "UPDATE app_settings SET event_status = ?, updated_by = ? WHERE id = 1", [status, adminId]);
    await writeAudit(tx, {
      userId: adminId,
      action: "EVENT_STATUS_CHANGED",
      entityType: "app_settings",
      entityId: "event",
      metadata: { from: before?.event_status, to: status },
    });
    await enqueueSync(tx, "RESULTS", RESULTS_KEY);
  });
}

export async function saveEvaluationSettings(adminId: string, input: { allowResubmission: boolean; tieBreakers: string[] }) {
  await withTransaction(async (tx) => {
    await run(tx, "UPDATE app_settings SET allow_resubmission = ?, tie_breakers = CAST(? AS JSON), updated_by = ? WHERE id = 1", [
      input.allowResubmission ? 1 : 0,
      JSON.stringify(input.tieBreakers),
      adminId,
    ]);
    await writeAudit(tx, { userId: adminId, action: "SETTINGS_UPDATED", entityType: "app_settings", metadata: input });
    await enqueueSync(tx, "RESULTS", RESULTS_KEY);
  });
}

export async function saveFormMapping(adminId: string, mapping: Json) {
  await withTransaction(async (tx) => {
    await run(tx, "UPDATE app_settings SET form_field_mapping = CAST(? AS JSON), updated_by = ? WHERE id = 1", [
      JSON.stringify(mapping),
      adminId,
    ]);
    await writeAudit(tx, { userId: adminId, action: "FORM_MAPPING_UPDATED", entityType: "app_settings" });
  });
}

/** Sheet column headers for total / evaluator / domains, plus each criterion's column. Re-queues every evaluated row. */
export async function saveSheetWriteback(
  adminId: string,
  input: { totalHeader: string; evaluatorHeader: string; domainsHeader: string; criteria: { id: string; sheetColumn: string }[] },
) {
  await withTransaction(async (tx) => {
    await run(tx, "UPDATE app_settings SET sheet_writeback = CAST(? AS JSON), updated_by = ? WHERE id = 1", [
      JSON.stringify({
        total_header: input.totalHeader,
        evaluator_header: input.evaluatorHeader,
        domains_header: input.domainsHeader,
      }),
      adminId,
    ]);
    for (const c of input.criteria) {
      await run(tx, "UPDATE evaluation_criteria SET sheet_column = ? WHERE id = ?", [c.sheetColumn || null, c.id]);
    }
    await writeAudit(tx, { userId: adminId, action: "SHEET_COLUMNS_UPDATED", entityType: "app_settings", metadata: input });
  });
  await enqueueFullResync(adminId);
}
