import type { CellValue, SheetsApi } from "./api";

/**
 * Idempotent spreadsheet writes.
 *
 * Keyed tabs: the LAST column holds a stable sync key (a database uuid). Each
 * run reads that column, updates rows whose key exists in place and writes
 * new keys below the last row. Replaying the same job any number of times
 * produces the same sheet — rows are never blindly appended.
 *
 * Callers must hold the sheets lease lock so row positions for new keys are
 * not computed concurrently.
 */

export interface TabDefinition {
  title: string;
  headers: readonly string[];
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

const quote = (title: string) => `'${title.replace(/'/g, "''")}'`;

export async function ensureTabs(api: SheetsApi, tabs: readonly TabDefinition[]) {
  const existing = new Set(await api.listTabs());
  await api.addTabs(tabs.filter((t) => !existing.has(t.title)).map((t) => t.title));
  await api.batchUpdate(
    tabs.map((t) => ({
      range: `${quote(t.title)}!A1:${columnLetter(t.headers.length - 1)}1`,
      values: [[...t.headers]],
    })),
  );
}

export interface KeyedRecord {
  key: string;
  /** Values for every column except the trailing key column. */
  values: CellValue[];
}

export async function upsertKeyedRows(api: SheetsApi, tab: TabDefinition, records: readonly KeyedRecord[]) {
  if (records.length === 0) return { updated: 0, appended: 0 };
  const width = tab.headers.length;
  const keyCol = columnLetter(width - 1);
  const lastCol = keyCol;

  const keyColumn = await api.getValues(`${quote(tab.title)}!${keyCol}2:${keyCol}`);
  const rowByKey = new Map<string, number>();
  keyColumn.forEach((row, i) => {
    const key = row[0];
    if (key !== null && key !== undefined && key !== "" && !rowByKey.has(String(key))) {
      rowByKey.set(String(key), i + 2);
    }
  });
  let nextRow = keyColumn.length + 2;

  // Last write wins if the same key appears twice in one batch.
  const latest = new Map<string, KeyedRecord>();
  for (const record of records) latest.set(record.key, record);

  let updated = 0;
  let appended = 0;
  const data: { range: string; values: CellValue[][] }[] = [];
  for (const record of latest.values()) {
    const values = [...record.values.slice(0, width - 1)];
    while (values.length < width - 1) values.push("");
    values.push(record.key);

    let row = rowByKey.get(record.key);
    if (row) updated++;
    else {
      row = nextRow++;
      rowByKey.set(record.key, row);
      appended++;
    }
    data.push({ range: `${quote(tab.title)}!A${row}:${lastCol}${row}`, values: [values.map(sanitize)] });
  }

  for (let i = 0; i < data.length; i += 500) await api.batchUpdate(data.slice(i, i + 500));
  return { updated, appended };
}

/** Rewrites a whole tab (used for derived tabs: Results, Dashboard). */
export async function replaceTable(api: SheetsApi, tab: TabDefinition, rows: readonly CellValue[][]) {
  const lastCol = columnLetter(tab.headers.length - 1);
  const values = [[...tab.headers], ...rows.map((r) => r.map(sanitize))];
  for (let i = 0; i < values.length; i += 1000) {
    const chunk = values.slice(i, i + 1000);
    await api.batchUpdate([{ range: `${quote(tab.title)}!A${i + 1}:${lastCol}${i + chunk.length}`, values: chunk }]);
  }
  // Clear leftovers after (not before) writing so the tab is never blank.
  await api.clear(`${quote(tab.title)}!A${values.length + 1}:${lastCol}`);
}

function sanitize(value: CellValue): CellValue {
  if (typeof value === "string") return value.length > 49_000 ? value.slice(0, 49_000) : value;
  return value ?? "";
}
