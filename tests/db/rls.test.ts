import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  as,
  assign,
  createEvaluator,
  createStudent,
  createTestDb,
  createUser,
  rejectsWith,
  setEventStatus,
} from "./harness";

describe("row level security", () => {
  let db: PGlite;
  let adminId: string;
  let evA: { userId: string; evaluatorId: string };
  let evB: { userId: string; evaluatorId: string };
  let s1: string;
  let s2: string;
  let s3: string;
  let a1: string;
  let a2: string;

  beforeAll(async () => {
    db = await createTestDb();
    adminId = await createUser(db, "admin@example.edu", "ADMIN");
    evA = await createEvaluator(db, "a@example.edu", "Evaluator A");
    evB = await createEvaluator(db, "b@example.edu", "Evaluator B");
    s1 = await createStudent(db, "23AD001");
    s2 = await createStudent(db, "23AD002");
    s3 = await createStudent(db, "23AD003");
    a1 = await assign(db, s1, evA.evaluatorId);
    a2 = await assign(db, s2, evB.evaluatorId);
    await setEventStatus(db, "LIVE");
    await as(db, "authenticated", evB.userId, () =>
      db.query("select public.submit_evaluation($1, 7, 'B private remarks')", [a2]),
    );
  });

  it("anon can read and call nothing", async () => {
    await rejectsWith(as(db, "anon", null, () => db.query("select * from public.students")), "permission denied");
    await rejectsWith(as(db, "anon", null, () => db.query("select * from public.evaluations")), "permission denied");
    await rejectsWith(
      as(db, "anon", null, () => db.query("select public.submit_evaluation($1, 5, null)", [a1])),
      "permission denied",
    );
  });

  it("evaluator sees only assigned students and their ideas", async () => {
    const students = await as(db, "authenticated", evA.userId, () =>
      db.query<{ id: string }>("select id, register_number, name from public.students"),
    );
    expect(students.rows.map((r) => r.id)).toEqual([s1]);

    const ideas = await as(db, "authenticated", evA.userId, () =>
      db.query<{ student_id: string }>("select student_id from public.ideas"),
    );
    expect(ideas.rows.map((r) => r.student_id)).toEqual([s1]);
  });

  it("evaluator cannot read student contact details", async () => {
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("select email, phone from public.students")),
      "permission denied",
    );
  });

  it("evaluator cannot see other evaluators' assignments, evaluations or profiles", async () => {
    const assignments = await as(db, "authenticated", evA.userId, () =>
      db.query<{ id: string }>("select id from public.evaluation_assignments"),
    );
    expect(assignments.rows.map((r) => r.id)).toEqual([a1]);

    const evaluations = await as(db, "authenticated", evA.userId, () => db.query("select * from public.evaluations"));
    expect(evaluations.rows).toEqual([]);

    const evaluators = await as(db, "authenticated", evA.userId, () =>
      db.query<{ id: string }>("select id from public.evaluators"),
    );
    expect(evaluators.rows.map((r) => r.id)).toEqual([evA.evaluatorId]);

    const profiles = await as(db, "authenticated", evA.userId, () =>
      db.query<{ id: string }>("select id from public.profiles"),
    );
    expect(profiles.rows.map((r) => r.id)).toEqual([evA.userId]);
  });

  it("evaluator cannot write tables directly", async () => {
    await rejectsWith(
      as(db, "authenticated", evA.userId, () =>
        db.query(
          "insert into public.evaluations (assignment_id, student_id, evaluator_id, score, status) values ($1, $2, $3, 10, 'IN_PROGRESS')",
          [a1, s1, evA.evaluatorId],
        ),
      ),
      "permission denied",
    );
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("update public.evaluations set score = 1")),
      "permission denied",
    );
    await rejectsWith(
      as(db, "authenticated", evA.userId, () =>
        db.query("insert into public.evaluation_assignments (student_id, evaluator_id) values ($1, $2)", [
          s3,
          evA.evaluatorId,
        ]),
      ),
      "permission denied",
    );
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("update public.students set name = 'x'")),
      "permission denied",
    );
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("update public.app_settings set event_status = 'LIVE'")),
      "permission denied",
    );
  });

  it("evaluator cannot use admin RPCs or read admin data", async () => {
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("select public.set_event_status('CLOSED')")),
      "FORBIDDEN",
    );
    await rejectsWith(
      as(db, "authenticated", evA.userId, () =>
        db.query("select public.confirm_allocation('INCREMENTAL', 'x', 50, 1, $1::jsonb)", [
          JSON.stringify([{ student_id: s3, evaluator_id: evA.evaluatorId }]),
        ]),
      ),
      "FORBIDDEN",
    );
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("select public.dashboard_stats()")),
      "FORBIDDEN",
    );
    const logs = await as(db, "authenticated", evA.userId, () => db.query("select * from public.audit_logs"));
    expect(logs.rows).toEqual([]);
    const queue = await as(db, "authenticated", evA.userId, () => db.query("select * from public.sheet_sync_queue"));
    expect(queue.rows).toEqual([]);
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("select * from public.student_overview")),
      "permission denied",
    );
    await rejectsWith(
      as(db, "authenticated", evA.userId, () =>
        db.query("select public.upsert_form_submissions('[]'::jsonb, 'CSV_IMPORT')"),
      ),
      "permission denied",
    );
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("select * from public.claim_sync_jobs(10)")),
      "permission denied",
    );
  });

  it("my_assignments view is scoped to the caller", async () => {
    const rows = await as(db, "authenticated", evA.userId, () =>
      db.query<{ assignment_id: string }>("select assignment_id from public.my_assignments"),
    );
    expect(rows.rows.map((r) => r.assignment_id)).toEqual([a1]);
  });

  it("disabling an evaluator revokes access immediately", async () => {
    await db.query("update public.evaluators set status = 'DISABLED' where id = $1", [evA.evaluatorId]);
    const rows = await as(db, "authenticated", evA.userId, () => db.query("select * from public.my_assignments"));
    expect(rows.rows).toEqual([]);
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("select public.submit_evaluation($1, 5, null)", [a1])),
      "NOT_AN_EVALUATOR",
    );
    await db.query("update public.evaluators set status = 'ACTIVE' where id = $1", [evA.evaluatorId]);
  });

  it("admin can read all rows through the client role", async () => {
    const students = await as(db, "authenticated", adminId, () => db.query("select id from public.students"));
    expect(students.rows).toHaveLength(3);
    const evaluations = await as(db, "authenticated", adminId, () => db.query("select id from public.evaluations"));
    expect(evaluations.rows).toHaveLength(1);
    const stats = await as(db, "authenticated", adminId, () =>
      db.query<{ s: { total_students: number; completed_evaluations: number } }>(
        "select public.dashboard_stats() as s",
      ),
    );
    expect(stats.rows[0].s).toMatchObject({ total_students: 3, completed_evaluations: 1 });
  });
});
