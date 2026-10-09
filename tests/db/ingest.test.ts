import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { one, pool, run } from "@/lib/db/sql";
import type { NormalizedSubmission } from "@/lib/forms/mapping";
import type { StudentCsvRow } from "@/lib/forms/students-csv";
import { ingestSubmissions, importStudents } from "@/lib/services/ingest";
import { submitEvaluation } from "@/lib/services/evaluations";
import { count, createCriterion, createEvaluatorAccount, createTestDb, hasMysql, select, setEventStatus, type TestDb } from "./harness";

const csv = (o: Partial<StudentCsvRow> = {}): StudentCsvRow => ({
  _row: 2,
  register_number: "23AD001",
  name: "Asha K",
  gender: "Female",
  department: "AI&DS",
  email: "asha@x.edu",
  phone: "111",
  ...o,
});

const sub = (o: Partial<NormalizedSubmission> = {}): NormalizedSubmission => ({
  _row: 2,
  register_number: "23AD001",
  name: "Asha",
  email: "asha@x.edu",
  phone: "777",
  department: "AI&DS",
  section: "B",
  abstract: "Smart water meter",
  ppt_url: "https://drive.google.com/file/d/abc/view",
  submitted_at: "2026-10-01T10:00:00.000Z",
  other_details: {},
  ...o,
});

describe.skipIf(!hasMysql)("student CSV import (master data)", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.drop();
  });

  it("inserts, updates and is idempotent", async () => {
    expect(await importStudents([csv()], null)).toMatchObject({ inserted: 1, updated: 0, status: "SUCCESS" });
    expect(await importStudents([csv()], null)).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(await importStudents([csv({ phone: "999" })], null)).toMatchObject({ updated: 1 });
    expect(await one(pool(), "SELECT register_number, gender, email, phone, source FROM students")).toEqual({
      register_number: "23AD001", gender: "Female", email: "asha@x.edu", phone: "999", source: "IMPORT",
    });
  });

  it("keeps stored values where the CSV cell is blank", async () => {
    await importStudents([csv()], null);
    await importStudents([csv({ gender: null, department: null, phone: null, name: "Asha Kumar" })], null);
    expect(await one(pool(), "SELECT name, gender, department, phone FROM students")).toEqual({
      name: "Asha Kumar", gender: "Female", department: "AI&DS", phone: "111",
    });
  });

  it("skips bad rows and emails owned by another student without failing the batch", async () => {
    const r = await importStudents(
      [csv({ _row: 2, register_number: "A1", email: "same@x.edu" }), csv({ _row: 3, register_number: "A2", email: "same@x.edu" }), csv({ _row: 4, register_number: "" }), csv({ _row: 5, register_number: "A3", name: "" })],
      null,
    );
    expect(r).toMatchObject({ inserted: 1, skipped: 3, status: "PARTIAL", received: 4 });
    expect(r.errors.map((e) => e.row)).toEqual([3, 4, 5]);
    expect(r.errors[0].error).toContain("already belongs to another student");
    const run1 = await one<{ status: string; errors: unknown[] }>(pool(), "SELECT status, errors FROM form_sync_runs");
    expect(run1!.status).toBe("PARTIAL");
    expect(run1!.errors).toHaveLength(3);
  });

  it("records the run in the audit log and queues sheet jobs", async () => {
    await importStudents([csv()], null);
    expect(await count("audit_logs", "action = 'STUDENT_IMPORT'")).toBe(1);
    expect(await count("sheet_sync_queue", "entity_type = 'STUDENT'")).toBe(1);
  });

  it("handles a full class (900 rows) and a no-change replay quickly", async () => {
    const rows = Array.from({ length: 900 }, (_, i) =>
      csv({ _row: i + 2, register_number: `25CS${String(i).padStart(4, "0")}`, name: `Student ${i}`, email: `s${i}@x.edu` }),
    );
    const t0 = Date.now();
    expect(await importStudents(rows, null)).toMatchObject({ inserted: 900, status: "SUCCESS" });
    const replayStart = Date.now();
    expect(await importStudents(rows, null)).toMatchObject({ inserted: 0, updated: 0, unchanged: 900 });
    console.log(`900-row import ${replayStart - t0} ms, replay ${Date.now() - replayStart} ms`);
    expect(await count("students")).toBe(900);
  });
});

describe.skipIf(!hasMysql)("problem statement ingestion", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
    await importStudents([csv()], null);
  });
  afterEach(async () => {
    await db.drop();
  });

  const ideas = () => select<{ abstract: string; matched_by: string; response_row: number; submission_status: string; ppt_url: string | null }>(
    "SELECT abstract, matched_by, response_row, submission_status, ppt_url FROM ideas ORDER BY created_at",
  );

  it("matches by register number and only fills blank student fields", async () => {
    expect(await ingestSubmissions([sub()], "APPS_SCRIPT", null)).toMatchObject({ inserted: 1, status: "SUCCESS" });
    // CSV name/phone win; blank section is filled from the form.
    expect(await one(pool(), "SELECT name, phone, section, department FROM students")).toEqual({ name: "Asha K", phone: "111", section: "B", department: "AI&DS" });
    expect(await ideas()).toEqual([
      { abstract: "Smart water meter", matched_by: "REGISTER_NUMBER", response_row: 2, submission_status: "SUBMITTED", ppt_url: "https://drive.google.com/file/d/abc/view" },
    ]);
  });

  it("is idempotent on replay and ignores JSON key order", async () => {
    await ingestSubmissions([sub({ other_details: { a: "1", bb: "2" } })], "APPS_SCRIPT", null);
    const jobsBefore = await count("sheet_sync_queue");
    expect(await ingestSubmissions([sub({ other_details: { bb: "2", a: "1" } })], "APPS_SCRIPT", null)).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(await count("sheet_sync_queue")).toBe(jobsBefore);
  });

  it("falls back to email when the register number on the form is wrong, and records what was typed", async () => {
    await ingestSubmissions([sub({ register_number: "23AD0O1" })], "APPS_SCRIPT", null);
    const row = await one<{ matched_by: string; other_details: Record<string, string> }>(pool(), "SELECT matched_by, other_details FROM ideas");
    expect(row!.matched_by).toBe("EMAIL");
    expect(row!.other_details["Register number on form"]).toBe("23AD0O1");
    expect(await count("students")).toBe(1);
  });

  it("creates unmatched students flagged 'not in CSV' and keeps the flag on replay, until a CSV import adds them", async () => {
    const r = sub({ register_number: "24ZZ999", email: "new@x.edu", name: "Newbie" });
    await ingestSubmissions([r], "APPS_SCRIPT", null);
    await ingestSubmissions([{ ...r, abstract: "Updated abstract", submitted_at: "2026-10-02T10:00:00.000Z" }], "APPS_SCRIPT", null);
    expect((await ideas()).map((i) => i.matched_by)).toEqual(["REGISTER_NUMBER", "CREATED"].slice(1));
    expect(await one(pool(), "SELECT source FROM students WHERE register_number = '24ZZ999'")).toEqual({ source: "FORM" });

    await importStudents([csv({ _row: 3, register_number: "24ZZ999", name: "Newbie", email: "new@x.edu" })], null);
    expect(await one(pool(), "SELECT matched_by FROM ideas i JOIN students s ON s.id = i.student_id WHERE s.register_number = '24ZZ999'")).toEqual({ matched_by: "REGISTER_NUMBER" });
    expect(await one(pool(), "SELECT source FROM students WHERE register_number = '24ZZ999'")).toEqual({ source: "IMPORT" });
  });

  it("skips responses that cannot be linked or created", async () => {
    const r = await ingestSubmissions(
      [sub({ register_number: "", email: "ghost@x.edu", name: "" }), sub({ register_number: "", email: null }), sub({ register_number: "NEW1", email: "n@x.edu", name: "" })],
      "APPS_SCRIPT",
      null,
    );
    expect(r).toMatchObject({ skipped: 3, status: "FAILED" });
    expect(await count("ideas")).toBe(0);
  });

  it("keeps the newest response; an older one never overwrites it", async () => {
    await ingestSubmissions([sub()], "APPS_SCRIPT", null);
    await ingestSubmissions([sub({ abstract: "Newer", ppt_url: null, submitted_at: "2026-10-02T10:00:00.000Z", _row: 5 })], "APPS_SCRIPT", null);
    const older = await ingestSubmissions([sub({ abstract: "Older", submitted_at: "2026-09-01T10:00:00.000Z", _row: 9 })], "APPS_SCRIPT", null);
    expect(older).toMatchObject({ unchanged: 1, updated: 0 });
    expect(await ideas()).toEqual([expect.objectContaining({ abstract: "Newer", submission_status: "INCOMPLETE", response_row: 5, ppt_url: null })]);
  });

  it("handles several responses for one student inside a single batch (newest wins, no errors)", async () => {
    const r = await ingestSubmissions(
      [sub({ abstract: "v1", _row: 2 }), sub({ abstract: "v2", _row: 3, submitted_at: "2026-10-02T10:00:00.000Z" }), sub({ abstract: "v3", _row: 4, submitted_at: "2026-10-03T10:00:00.000Z" })],
      "SHEETS_PULL",
      null,
    );
    expect(r).toMatchObject({ inserted: 1, updated: 2, skipped: 0 });
    expect(await ideas()).toEqual([expect.objectContaining({ abstract: "v3", response_row: 4 })]);
  });

  it("queues a response-row update when a completed evaluation exists and the response changes", async () => {
    await ingestSubmissions([sub()], "APPS_SCRIPT", null);
    const ev = await createEvaluatorAccount("e@x.edu");
    const c = await createCriterion("Overall", 10);
    await setEventStatus("LIVE");
    const studentId = (await one<{ id: string }>(pool(), "SELECT id FROM students"))!.id;
    await submitEvaluation(ev.evaluatorId, { studentId, scores: { [c]: 5 }, remarks: null, domainIds: [] });
    await run(pool(), "DELETE FROM sheet_sync_queue");
    await ingestSubmissions([sub({ abstract: "Edited", submitted_at: "2026-10-04T10:00:00.000Z", _row: 7 })], "APPS_SCRIPT", null);
    const jobs = (await select<{ entity_type: string }>("SELECT entity_type FROM sheet_sync_queue")).map((j) => j.entity_type);
    expect(jobs).toEqual(expect.arrayContaining(["STUDENT", "RESPONSE_ROW"]));
  });

  it("replays a 900-row sheet without writing anything", async () => {
    const rows = Array.from({ length: 900 }, (_, i) =>
      sub({ _row: i + 2, register_number: `26CS${String(i).padStart(4, "0")}`, email: `r${i}@x.edu`, name: `S${i}`, submitted_at: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString() }),
    );
    const t0 = Date.now();
    expect(await ingestSubmissions(rows, "SHEETS_PULL", null)).toMatchObject({ inserted: 900, skipped: 0 });
    const replay = Date.now();
    expect(await ingestSubmissions(rows, "SHEETS_PULL", null)).toMatchObject({ inserted: 0, updated: 0, unchanged: 900 });
    console.log(`900-row ingest ${replay - t0} ms, replay ${Date.now() - replay} ms`);
    expect(await count("ideas")).toBe(901 - 1 + 0 /* 900 new */);
  });
});
