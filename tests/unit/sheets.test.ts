import { describe, expect, it } from "vitest";
import type { CellValue, SheetsApi } from "@/lib/sheets/api";
import { columnLetter, ensureTabs, replaceTable, upsertKeyedRows } from "@/lib/sheets/engine";
import { TABS, evaluationRecord } from "@/lib/sheets/tabs";

/** In-memory spreadsheet implementing the subset of the Sheets API we use. */
class FakeSheets implements SheetsApi {
  tabs = new Map<string, CellValue[][]>();
  calls = 0;
  failNext = 0;

  private guard() {
    this.calls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("Sheets API 503");
    }
  }

  private parse(range: string) {
    const m = range.match(/^'(.+)'!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
    if (!m) throw new Error(`bad range ${range}`);
    const col = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    return {
      title: m[1].replace(/''/g, "'"),
      c1: col(m[2]),
      r1: Number(m[3] ?? 1) - 1,
      c2: col(m[4] ?? m[2]),
      r2: m[5] ? Number(m[5]) - 1 : Number.POSITIVE_INFINITY,
    };
  }

  private grid(title: string) {
    const g = this.tabs.get(title);
    if (!g) throw new Error(`no tab ${title}`);
    return g;
  }

  async listTabs() {
    this.guard();
    return [...this.tabs.keys()];
  }
  async addTabs(titles: string[]) {
    this.guard();
    for (const t of titles) this.tabs.set(t, []);
  }
  async getValues(range: string) {
    this.guard();
    const { title, c1, r1, c2, r2 } = this.parse(range);
    const g = this.grid(title);
    const out: CellValue[][] = [];
    for (let r = r1; r < Math.min(g.length, r2 + 1); r++) out.push((g[r] ?? []).slice(c1, c2 + 1));
    while (out.length && out[out.length - 1].every((v) => v === "" || v == null)) out.pop();
    return out;
  }
  async batchUpdate(data: { range: string; values: CellValue[][] }[]) {
    this.guard();
    for (const { range, values } of data) {
      const { title, c1, r1 } = this.parse(range);
      const g = this.grid(title);
      values.forEach((row, i) => {
        g[r1 + i] ??= [];
        row.forEach((v, j) => (g[r1 + i][c1 + j] = v));
      });
    }
  }
  async clear(range: string) {
    this.guard();
    const { title, r1 } = this.parse(range);
    this.grid(title).length = Math.min(this.grid(title).length, r1);
  }
}

const tab = { title: "Evaluations", headers: TABS.EVALUATION.headers };
const criteria = [{ id: "c1", name: "Innovation", max_marks: 10 }];
const record_ = (key: string, score: number) => record(key, score);
const record = (key: string, score: number, remarks = "ok") =>
  evaluationRecord(
    {
      evaluation_id: key,
      status: "COMPLETED",
      total_score: score,
      max_total: 10,
      remarks,
      decision: "SELECTED",
      started_at: "2026-10-08T05:00:00Z",
      submitted_at: "2026-10-08T05:00:00Z",
      updated_at: "2026-10-08T05:00:00Z",
      student_id: `s-${key}`,
      register_number: `R-${key}`,
      student_name: `Student ${key}`,
      department: "CSE",
      evaluator_id: "e1",
      evaluator_name: "Evaluator A",
      scores: { c1: score },
      domain_ids: [],
      domains: "GenAI",
    },
    criteria,
  );
// Column positions in the Evaluations tab.
const TOTAL = 4;
const SUMMARY = 7;
const REMARKS = 9;

describe("columnLetter", () => {
  it.each([
    [0, "A"],
    [25, "Z"],
    [26, "AA"],
    [701, "ZZ"],
  ])("%i -> %s", (i, l) => expect(columnLetter(i)).toBe(l));
});

describe("sheets engine", () => {
  it("never writes the Status (decision) to the sheet", () => {
    const record = record_("k", 7);
    expect(JSON.stringify(record)).not.toMatch(/SELECTED|Selected|WAITLISTED|REJECTED/);
    expect(TABS.EVALUATION.headers.join(",")).not.toMatch(/status.*(select|reject)/i);
  });

  it("creates missing tabs with headers", async () => {
    const api = new FakeSheets();
    await ensureTabs(api, [tab]);
    expect(api.tabs.get("Evaluations")?.[0]).toEqual([...TABS.EVALUATION.headers]);
  });

  it("appends new keys and updates existing rows in place", async () => {
    const api = new FakeSheets();
    await ensureTabs(api, [tab]);
    expect(await upsertKeyedRows(api, tab, [record("a", 7), record("b", 8)])).toEqual({ updated: 0, appended: 2 });
    expect(await upsertKeyedRows(api, tab, [record("a", 9, "revised"), record("c", 5)])).toEqual({
      updated: 1,
      appended: 1,
    });
    const rows = api.tabs.get("Evaluations")!;
    expect(rows).toHaveLength(4);
    expect([rows[1][TOTAL], rows[1][REMARKS], rows[1][SUMMARY]]).toEqual([9, "revised", "Innovation: 9/10"]);
    expect(rows.map((r) => r.at(-1))).toEqual(["Sync Key", "a", "b", "c"]);
  });

  it("is idempotent: replaying the same batch never duplicates rows", async () => {
    const api = new FakeSheets();
    await ensureTabs(api, [tab]);
    const batch = [record("a", 7), record("b", 8), record("a", 6)];
    await upsertKeyedRows(api, tab, batch);
    const snapshot = structuredClone(api.tabs.get("Evaluations"));
    await upsertKeyedRows(api, tab, batch);
    await upsertKeyedRows(api, tab, batch);
    expect(api.tabs.get("Evaluations")).toEqual(snapshot);
    expect(snapshot).toHaveLength(3);
    expect(snapshot![1][TOTAL]).toBe(6); // last write in a batch wins
  });

  it("finds existing rows even if the sheet was re-ordered manually", async () => {
    const api = new FakeSheets();
    await ensureTabs(api, [tab]);
    await upsertKeyedRows(api, tab, [record("a", 1), record("b", 2)]);
    const g = api.tabs.get("Evaluations")!;
    [g[1], g[2]] = [g[2], g[1]];
    await upsertKeyedRows(api, tab, [record("a", 10)]);
    expect(g[2][TOTAL]).toBe(10);
    expect(g[1][TOTAL]).toBe(2);
  });

  it("propagates API failures so the queue can retry, then succeeds", async () => {
    const api = new FakeSheets();
    await ensureTabs(api, [tab]);
    api.failNext = 1;
    await expect(upsertKeyedRows(api, tab, [record("a", 4)])).rejects.toThrow("503");
    await upsertKeyedRows(api, tab, [record("a", 4)]);
    expect(api.tabs.get("Evaluations")).toHaveLength(2);
  });

  it("writes user text as plain values (formula injection is handled by RAW input)", async () => {
    const api = new FakeSheets();
    await ensureTabs(api, [tab]);
    await upsertKeyedRows(api, tab, [record("a", 5, '=IMPORTXML("http://evil")')]);
    expect(api.tabs.get("Evaluations")![1][REMARKS]).toBe('=IMPORTXML("http://evil")');
  });

  it("replaceTable rewrites derived tabs and clears leftover rows", async () => {
    const api = new FakeSheets();
    const results = { title: "Results", headers: TABS.RESULTS.headers };
    await ensureTabs(api, [results]);
    await replaceTable(api, results, [
      [1, "A", "a", "CSE", 9, 10, "90%", "", "E"],
      [2, "B", "b", "CSE", 8, 10, "80%", "", "E"],
      [3, "C", "c", "CSE", 7, 10, "70%", "", "E"],
    ]);
    await replaceTable(api, results, [[1, "C", "c", "CSE", 10, 10, "100%", "", "E"]]);
    expect(api.tabs.get("Results")).toEqual([[...TABS.RESULTS.headers], [1, "C", "c", "CSE", 10, 10, "100%", "", "E"]]);
  });
});
