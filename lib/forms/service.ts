import "server-only";
import { googleConfig } from "@/lib/env";
import { GoogleSheetsApi } from "@/lib/sheets/api";
import { portalOwnedHeaders, resolveWritebackSettings } from "@/lib/sheets/writeback";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/database";
import { normalizeSubmissions, resolveMapping } from "./mapping";
import { parseStudentCsv } from "./students-csv";

export type IngestSource = "APPS_SCRIPT" | "SHEETS_PULL" | "CSV_IMPORT";

export interface IngestResult {
  run_id: string | null;
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  received: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: { row?: string | number; register_number?: string; error: string }[];
}

async function recordFailedRun(source: IngestSource, received: number, error: string, actorId: string | null) {
  const db = createAdminClient();
  const { data } = await db
    .from("form_sync_runs")
    .insert({ source, status: "FAILED", received, skipped: received, errors: [{ error }], triggered_by: actorId })
    .select("id")
    .single();
  return {
    run_id: data?.id ?? null,
    status: "FAILED" as const,
    received,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: received,
    errors: [{ error }],
  };
}

/** Student master data from CSV: name, register number, gender, department, email, phone number. */
export async function importStudentRows(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  actorId: string | null,
): Promise<IngestResult> {
  const parsed = parseStudentCsv(headers, rows);
  if (parsed.missingFields.length) {
    return recordFailedRun(
      "CSV_IMPORT",
      rows.length,
      `Required column(s) not found: ${parsed.missingFields.join(", ")}. Expected: name, register number, gender, department, email, phone number.`,
      actorId,
    );
  }
  const { data, error } = await createAdminClient().rpc("import_students", {
    p_rows: parsed.rows as unknown as Json,
    p_actor: actorId,
  });
  if (error) throw new Error(error.message);
  return data as unknown as IngestResult;
}

/**
 * Problem statement responses (Apps Script webhook or Sheets pull):
 * map headers → normalise → link to students by register number / email.
 */
export async function ingestFormRows(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  source: "APPS_SCRIPT" | "SHEETS_PULL",
  actorId: string | null,
  firstDataRow = 2,
): Promise<IngestResult> {
  const db = createAdminClient();
  const [{ data: settings, error: settingsError }, { data: criteria, error: criteriaError }] = await Promise.all([
    db.from("app_settings").select("form_field_mapping, sheet_writeback").single(),
    db.from("evaluation_criteria").select("id, name, sheet_column"),
  ]);
  if (settingsError) throw new Error(settingsError.message);
  if (criteriaError) throw new Error(criteriaError.message);

  const owned = portalOwnedHeaders(criteria ?? [], resolveWritebackSettings(settings.sheet_writeback));
  const { submissions, missingFields } = normalizeSubmissions(
    headers,
    rows,
    resolveMapping(settings.form_field_mapping),
    firstDataRow,
    owned,
  );
  if (missingFields.length > 0) {
    return recordFailedRun(
      source,
      rows.length,
      `Required column(s) not found: ${missingFields.join(", ")}. Check the field mapping in Settings.`,
      actorId,
    );
  }

  const { data, error } = await db.rpc("upsert_form_submissions", {
    p_rows: submissions as unknown as Json,
    p_source: source,
    p_actor: actorId,
  });
  if (error) throw new Error(error.message);
  return data as unknown as IngestResult;
}

export function responseSheet() {
  const config = googleConfig();
  if (!config?.formResponseSheetId) return null;
  return {
    api: new GoogleSheetsApi(config, config.formResponseSheetId),
    tab: config.formResponseRange,
  };
}

/** Pulls the whole problem statement response sheet via the Sheets API. */
export async function pullFormResponses(actorId: string | null): Promise<IngestResult> {
  const sheet = responseSheet();
  if (!sheet) throw new Error("GOOGLE_FORM_RESPONSE_SHEET_ID is not configured");
  const values = await sheet.api.getValues(`'${sheet.tab.replace(/'/g, "''")}'`);
  const [headerRow = [], ...rows] = values;
  return ingestFormRows(headerRow.map((h) => String(h ?? "")), rows, "SHEETS_PULL", actorId);
}

/** Header row of the response sheet (for the admin column-mapping screen). */
export async function readResponseHeaders(): Promise<string[] | null> {
  const sheet = responseSheet();
  if (!sheet) return null;
  const values = await sheet.api.getValues(`'${sheet.tab.replace(/'/g, "''")}'!1:1`);
  return (values[0] ?? []).map((h) => String(h ?? "").trim());
}
