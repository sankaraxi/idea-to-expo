import "server-only";
import { googleConfig } from "@/lib/env";
import { listCriteria } from "@/lib/services/criteria";
import { ingestSubmissions, importStudents, recordFailedRun, type IngestResult } from "@/lib/services/ingest";
import { getSettingsRow } from "@/lib/services/settings";
import { GoogleSheetsApi } from "@/lib/sheets/api";
import { portalOwnedHeaders, resolveWritebackSettings } from "@/lib/sheets/writeback";
import { normalizeSubmissions, resolveMapping } from "./mapping";
import { parseStudentCsv } from "./students-csv";

export type { IngestResult };

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
  return importStudents(parsed.rows, actorId);
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
  const [settings, criteria] = await Promise.all([getSettingsRow(), listCriteria()]);
  const owned = portalOwnedHeaders(criteria, resolveWritebackSettings(settings.sheet_writeback));
  const { submissions, missingFields } = normalizeSubmissions(headers, rows, resolveMapping(settings.form_field_mapping), firstDataRow, owned);
  if (missingFields.length > 0) {
    return recordFailedRun(
      source,
      rows.length,
      `Required column(s) not found: ${missingFields.join(", ")}. Check the field mapping in Settings.`,
      actorId,
    );
  }
  return ingestSubmissions(submissions, source, actorId);
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
