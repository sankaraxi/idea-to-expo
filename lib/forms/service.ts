import "server-only";
import { googleConfig } from "@/lib/env";
import { GoogleSheetsApi } from "@/lib/sheets/api";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/database";
import { normalizeSubmissions, resolveMapping } from "./mapping";

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

/**
 * Single ingestion path for Apps Script webhooks, Sheets pulls and CSV
 * imports: map headers → normalise → idempotent register-number upsert.
 */
export async function ingestRows(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  source: IngestSource,
  actorId: string | null,
  firstDataRow = 2,
): Promise<IngestResult> {
  const db = createAdminClient();
  const { data: settings, error: settingsError } = await db
    .from("app_settings")
    .select("form_field_mapping")
    .single();
  if (settingsError) throw new Error(settingsError.message);

  const mapping = resolveMapping(settings.form_field_mapping);
  const { submissions, missingFields } = normalizeSubmissions(headers, rows, mapping, firstDataRow);

  if (missingFields.length > 0) {
    const error = `Required column(s) not found: ${missingFields.join(", ")}. Check the field mapping in Settings.`;
    const { data } = await db
      .from("form_sync_runs")
      .insert({ source, status: "FAILED", received: rows.length, skipped: rows.length, errors: [{ error }], triggered_by: actorId })
      .select("id")
      .single();
    return {
      run_id: data?.id ?? null,
      status: "FAILED",
      received: rows.length,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: rows.length,
      errors: [{ error }],
    };
  }

  const { data, error } = await db.rpc("upsert_form_submissions", {
    p_rows: submissions as unknown as Json,
    p_source: source,
    p_actor: actorId,
  });
  if (error) throw new Error(error.message);
  return data as unknown as IngestResult;
}

/** Pulls the whole Google Form response sheet via the Sheets API. */
export async function pullFormResponses(actorId: string | null): Promise<IngestResult> {
  const config = googleConfig();
  if (!config?.formResponseSheetId) {
    throw new Error("GOOGLE_FORM_RESPONSE_SHEET_ID is not configured");
  }
  const api = new GoogleSheetsApi(config, config.formResponseSheetId);
  const range = `'${config.formResponseRange.replace(/'/g, "''")}'`;
  const values = await api.getValues(range);
  const [headerRow = [], ...rows] = values;
  return ingestRows(headerRow.map((h) => String(h ?? "")), rows, "SHEETS_PULL", actorId);
}
