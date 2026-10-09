import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { one, pool, rows, run, uuid } from "@/lib/db/sql";
import { enqueueSync } from "@/lib/services/sync-queue";
import { count, createCriterion, createEvaluatorAccount, createStudent, createTestDb, hasMysql, rejectsWith, type TestDb } from "./harness";

describe.skipIf(!hasMysql)("database schema (database/idea_to_expo.sql)", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.drop();
  });

  it("creates the settings row with safe defaults", async () => {
    const s = await one<{ event_status: string; allow_resubmission: boolean; tie_breakers: string[]; form_field_mapping: object }>(
      pool(),
      "SELECT * FROM app_settings",
    );
    expect(s).toMatchObject({ event_status: "NOT_STARTED", allow_resubmission: false, tie_breakers: [], form_field_mapping: {} });
  });

  it("can be imported repeatedly without error or duplicate rows", async () => {
    await db.reimport();
    await db.reimport();
    expect(await count("app_settings")).toBe(1);
  });

  it("returns datetimes as UTC ISO strings and tinyint(1) as booleans", async () => {
    const c = await createCriterion("Innovation", 10);
    const row = await one<{ is_active: boolean; created_at: string }>(pool(), "SELECT is_active, created_at FROM evaluation_criteria WHERE id = ?", [c]);
    expect(row!.is_active).toBe(true);
    expect(row!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The connection clock is UTC: stored "now" is within a few seconds of JS now.
    expect(Math.abs(Date.parse(row!.created_at) - Date.now())).toBeLessThan(15_000);
  });

  it("enforces normalised identifiers with CHECK constraints", async () => {
    const insert = (reg: string, email: string | null) =>
      run(pool(), "INSERT INTO students (id, register_number, name, email) VALUES (?, ?, 'X', ?)", [uuid(), reg, email]);
    await rejectsWith(insert("ab001", null), "ER_CHECK_CONSTRAINT_VIOLATED"); // lower-case
    await rejectsWith(insert("AB 001", null), "ER_CHECK_CONSTRAINT_VIOLATED"); // whitespace
    await rejectsWith(insert("AB001", "Upper@X.EDU"), "ER_CHECK_CONSTRAINT_VIOLATED");
    await insert("AB001", "ok@x.edu");
    await rejectsWith(insert("AB001", null), "ER_DUP_ENTRY");
    await rejectsWith(insert("AB002", "OK@x.edu"), "ER_CHECK_CONSTRAINT_VIOLATED");
    await insert("AB002", null);
    await insert("AB003", null); // many students may have no email
  });

  it("constrains criteria and keeps names unique ignoring case", async () => {
    await createCriterion("Innovation", 10, "STARS");
    await rejectsWith(createCriterion("Too many stars", 20, "STARS"), "ER_CHECK_CONSTRAINT_VIOLATED");
    await rejectsWith(createCriterion("innovation", 5), "ER_DUP_ENTRY");
    await rejectsWith(createCriterion("Zero", 0), "ER_CHECK_CONSTRAINT_VIOLATED");
    await rejectsWith(createCriterion("Huge", 101), "ER_CHECK_CONSTRAINT_VIOLATED");
  });

  it("allows exactly one evaluation per student and requires a total when completed", async () => {
    const ev = await createEvaluatorAccount("e@x.edu");
    const student = await createStudent("S001");
    const insert = (status: string, total: number | null) =>
      run(pool(), "INSERT INTO evaluations (id, student_id, evaluator_id, status, total_score, max_total, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        uuid(), student, ev.evaluatorId, status, total, total === null ? null : 10, total === null ? null : new Date(),
      ]);
    await rejectsWith(insert("COMPLETED", null), "ER_CHECK_CONSTRAINT_VIOLATED");
    await insert("IN_PROGRESS", null);
    await rejectsWith(insert("IN_PROGRESS", null), "ER_DUP_ENTRY");
  });

  it("has no per-evaluator limit column", async () => {
    const cols = await rows<{ COLUMN_NAME: string }>(
      pool(),
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('evaluators', 'app_settings')",
    );
    expect(cols.map((c) => c.COLUMN_NAME).filter((c) => /max|limit|cap/i.test(c))).toEqual([]);
  });

  it("keeps at most one PENDING sync job per entity (coalescing)", async () => {
    const id = uuid();
    await enqueueSync(pool(), "STUDENT", id);
    await enqueueSync(pool(), "STUDENT", id);
    await enqueueSync(pool(), "STUDENT", id);
    expect(await count("sheet_sync_queue", "entity_id = ?", [id])).toBe(1);
    // Once it is being processed, a new change must be able to queue again.
    await run(pool(), "UPDATE sheet_sync_queue SET status = 'PROCESSING' WHERE entity_id = ?", [id]);
    await enqueueSync(pool(), "STUDENT", id);
    expect(await count("sheet_sync_queue", "entity_id = ?", [id])).toBe(2);
    await enqueueSync(pool(), "EVALUATOR", id); // a different entity type is independent
    expect(await count("sheet_sync_queue", "entity_id = ?", [id])).toBe(3);
  });

  it("cascades deletes from students to ideas and evaluations", async () => {
    const ev = await createEvaluatorAccount("e@x.edu");
    const student = await createStudent("S001");
    await run(pool(), "INSERT INTO evaluations (id, student_id, evaluator_id) VALUES (?, ?, ?)", [uuid(), student, ev.evaluatorId]);
    await run(pool(), "DELETE FROM students WHERE id = ?", [student]);
    expect(await count("ideas")).toBe(0);
    expect(await count("evaluations")).toBe(0);
  });
});
