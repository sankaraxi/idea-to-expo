import { z } from "zod";
import { FORM_FIELDS, isScoreColumnHeader, matchHeaders, normalizeHeader, normalizeRegisterNumber, type FormFieldMapping } from "@/lib/forms/mapping";
import type { CellValue } from "./api";
import { columnLetter } from "./engine";

/**
 * Writes evaluation results back into the problem statement response sheet,
 * into the score columns the organisers added beside the form responses.
 *
 * Columns are located by header text (row 1), and the student's row by
 * register number (falling back to email), so the sheet may be sorted or
 * have columns inserted without breaking the sync.
 */

export const writebackSettingsSchema = z.object({
  totalHeader: z.string().trim().max(200).default(""),
  evaluatorHeader: z.string().trim().max(200).default(""),
  domainsHeader: z.string().trim().max(200).default(""),
});
export type WritebackSettings = z.infer<typeof writebackSettingsSchema>;

export function resolveWritebackSettings(stored: unknown): WritebackSettings {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const parsed = writebackSettingsSchema.safeParse({
    totalHeader: raw.total_header ?? raw.totalHeader,
    evaluatorHeader: raw.evaluator_header ?? raw.evaluatorHeader,
    domainsHeader: raw.domains_header ?? raw.domainsHeader,
  });
  return parsed.success ? parsed.data : { totalHeader: "", evaluatorHeader: "", domainsHeader: "" };
}

export interface CriterionColumn {
  id: string;
  name: string;
  sheet_column: string | null;
  /** Inactive criteria are not scored, so they do not take a positional "criteria N" column. */
  is_active?: boolean;
}

export const criterionHeader = (c: Pick<CriterionColumn, "name" | "sheet_column">) => (c.sheet_column?.trim() || c.name).trim();

/** Headers the portal writes to; excluded from form ingestion. */
export function portalOwnedHeaders(criteria: readonly CriterionColumn[], settings: WritebackSettings): string[] {
  return [
    ...criteria.map(criterionHeader),
    settings.totalHeader,
    settings.evaluatorHeader,
    settings.domainsHeader,
  ].filter((h) => h.trim() !== "");
}

/** Column K (0-based 10): first criterion score column when no header matches; total follows the last criterion. */
export const SCORE_START_COL = 10;

export interface ResponseLayout {
  registerCol: number | null;
  emailCol: number | null;
  criterionCols: Map<string, number>;
  totalCol: number | null;
  evaluatorCol: number | null;
  domainsCol: number | null;
  /** Human-readable problems (missing columns) for the admin settings page. */
  missing: string[];
}

export function resolveLayout(
  headers: readonly string[],
  mapping: FormFieldMapping,
  criteria: readonly CriterionColumn[],
  settings: WritebackSettings,
): ResponseLayout {
  const normalized = headers.map((h) => normalizeHeader(String(h ?? "")));
  const find = (header: string) => {
    const target = normalizeHeader(header);
    if (!target) return null;
    const index = normalized.indexOf(target);
    return index >= 0 ? index : null;
  };

  const owned = new Set(portalOwnedHeaders(criteria, settings).map(normalizeHeader));
  normalized.forEach((h) => isScoreColumnHeader(h) && owned.add(h));
  const { fieldByIndex } = matchHeaders(headers, mapping.fields, FORM_FIELDS, owned);
  let registerCol: number | null = null;
  let emailCol: number | null = null;
  fieldByIndex.forEach((field, i) => {
    if (field === "register_number") registerCol = i;
    if (field === "email") emailCol = i;
  });

  const missing: string[] = [];
  if (registerCol === null && emailCol === null) missing.push("Register number / email column");
  const criterionCols = new Map<string, number>();
  let position = 0; // the k-th active criterion falls back to a header named "criteria k"
  for (const c of criteria) {
    if (c.is_active !== false) position++;
    // Last resort: active criteria fill the fixed score block starting at column K.
    const col =
      find(criterionHeader(c)) ??
      (c.is_active !== false ? (find(`criteria ${position}`) ?? SCORE_START_COL + position - 1) : null);
    if (col === null) missing.push(`Criterion column “${criterionHeader(c)}”`);
    else criterionCols.set(c.id, col);
  }
  // Total: the configured header, else a column called "total score" / "total".
  const totalCol = find(settings.totalHeader) ?? find("total score") ?? find("total") ?? SCORE_START_COL + position;
  if (totalCol === null) missing.push(settings.totalHeader ? `Total column “${settings.totalHeader}”` : "Total column (not set)");
  const evaluatorCol = find(settings.evaluatorHeader);
  if (settings.evaluatorHeader && evaluatorCol === null) missing.push(`Evaluator column “${settings.evaluatorHeader}”`);
  const domainsCol = find(settings.domainsHeader);
  if (settings.domainsHeader && domainsCol === null) missing.push(`Domains column “${settings.domainsHeader}”`);

  return { registerCol, emailCol, criterionCols, totalCol, evaluatorCol, domainsCol, missing };
}

const normEmail = (v: CellValue | undefined) => String(v ?? "").trim().toLowerCase();
const normReg = (v: CellValue | undefined) => normalizeRegisterNumber(String(v ?? ""));

/**
 * 1-based sheet row for the student: the latest response matching the
 * register number, else the latest matching the email. `columns[i]` holds the
 * value at sheet row i + 2.
 */
export function findResponseRow(
  registerColumn: readonly CellValue[],
  emailColumn: readonly CellValue[],
  student: { register_number: string; email: string | null },
): number | null {
  const reg = normReg(student.register_number);
  for (let i = registerColumn.length - 1; i >= 0; i--) {
    if (reg && normReg(registerColumn[i]) === reg) return i + 2;
  }
  const email = (student.email ?? "").toLowerCase();
  if (email) {
    for (let i = emailColumn.length - 1; i >= 0; i--) {
      if (normEmail(emailColumn[i]) === email) return i + 2;
    }
  }
  return null;
}

export interface WritebackValues {
  scores: Record<string, number>;
  total: number;
  evaluatorName: string;
  domains: string;
}

/** Cell updates for one response row. `values === null` clears the cells (released / reopened). */
export function buildRowUpdates(
  sheetTitle: string,
  row: number,
  layout: ResponseLayout,
  values: WritebackValues | null,
): { range: string; values: CellValue[][] }[] {
  const tab = `'${sheetTitle.replace(/'/g, "''")}'`;
  const cell = (col: number, value: CellValue) => ({ range: `${tab}!${columnLetter(col)}${row}`, values: [[value]] });
  const updates: { range: string; values: CellValue[][] }[] = [];
  layout.criterionCols.forEach((col, criterionId) => updates.push(cell(col, values?.scores[criterionId] ?? "")));
  if (layout.totalCol !== null) updates.push(cell(layout.totalCol, values?.total ?? ""));
  if (layout.evaluatorCol !== null) updates.push(cell(layout.evaluatorCol, values?.evaluatorName ?? ""));
  if (layout.domainsCol !== null) updates.push(cell(layout.domainsCol, values?.domains ?? ""));
  return updates;
}
