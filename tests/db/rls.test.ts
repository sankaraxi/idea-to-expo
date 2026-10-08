import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  as,
  createCriterion,
  createEvaluator,
  createStudent,
  createTestDb,
  createUser,
  rejectsWith,
  setEventStatus,
} from "./harness";

describe("row level security (search-and-claim)", () => {
  let db: PGlite;
  let adminId: string;
  let evA: { userId: string; evaluatorId: string };
  let evB: { userId: string; evaluatorId: string };
  let s1: string;
  let s2: string;
  let s3: string;
  let criterion: string;

  beforeAll(async () => {
    db = await createTestDb();
    adminId = await createUser(db, "admin@example.edu", "ADMIN");
    evA = await createEvaluator(db, "a@example.edu", "Evaluator A");
    evB = await createEvaluator(db, "b@example.edu", "Evaluator B");
    s1 = await createStudent(db, "23AD001", { name: "Asha" });
    s2 = await createStudent(db, "23AD002", { name: "Bala" });
    s3 = await createStudent(db, "23AD003", { name: "Chitra" });
    criterion = await createCriterion(db, "Overall", 10);
    await setEventStatus(db, "LIVE");
    await as(db, "authenticated", evA.userId, () =>
      db.query("select public.save_evaluation_draft($1, $2::jsonb, 'A notes', '{}')", [s1, JSON.stringify({ [criterion]: 4 })]),
    );
    await as(db, "authenticated", evB.userId, () =>
      db.query("select public.submit_evaluation($1, $2::jsonb, 'B private remarks', '{}')", [s2, JSON.stringify({ [criterion]: 7 })]),
    );
  });

  it("anon can read and call nothing", async () => {
    await rejectsWith(as(db, "anon", null, () => db.query("select * from public.students")), "permission denied");
    await rejectsWith(as(db, "anon", null, () => db.query("select * from public.search_students('23', 10)")), "permission denied");
    await rejectsWith(
      as(db, "anon", null, () => db.query("select public.submit_evaluation($1, '{}'::jsonb, null, '{}')", [s3])),
      "permission denied",
    );
  });

  it("evaluators find any active student via search, with claim status but no other evaluator's data", async () => {
    const rows = await as(db, "authenticated", evA.userId, () =>
      db.query<{ register_number: string; email: string; claim_status: string }>(
        "select register_number, email, claim_status from public.search_students('23ad', 10)",
      ),
    );
    expect(rows.rows.map((r) => [r.register_number, r.claim_status])).toEqual([
      ["23AD001", "MINE_IN_PROGRESS"],
      ["23AD002", "TAKEN"],
      ["23AD003", "AVAILABLE"],
    ]);
    expect(rows.rows[0].email).toBe("23ad001@example.edu");

    const byName = await as(db, "authenticated", evA.userId, () =>
      db.query<{ register_number: string }>("select register_number from public.search_students('chit', 10)"),
    );
    expect(byName.rows).toEqual([{ register_number: "23AD003" }]);
    const byEmail = await as(db, "authenticated", evA.userId, () =>
      db.query<{ register_number: string }>("select register_number from public.search_students('23ad002@', 10)"),
    );
    expect(byEmail.rows).toEqual([{ register_number: "23AD002" }]);
    const tooShort = await as(db, "authenticated", evA.userId, () => db.query("select * from public.search_students('2', 10)"));
    expect(tooShort.rows).toEqual([]);
    const wildcard = await as(db, "authenticated", evA.userId, () => db.query("select * from public.search_students('%%', 10)"));
    expect(wildcard.rows).toEqual([]);

    const taken = await as(db, "authenticated", evA.userId, () =>
      db.query<{ d: { claim_status: string; evaluation: unknown; idea: { abstract: string } } }>(
        "select public.get_student_for_evaluation($1) as d",
        [s2],
      ),
    );
    expect(taken.rows[0].d).toMatchObject({ claim_status: "TAKEN", evaluation: null, idea: { abstract: "An abstract" } });
  });

  it("direct table reads are limited to claimed students and own evaluations", async () => {
    const students = await as(db, "authenticated", evA.userId, () =>
      db.query<{ id: string }>("select id from public.students"),
    );
    expect(students.rows.map((r) => r.id)).toEqual([s1]);
    const ideas = await as(db, "authenticated", evA.userId, () => db.query<{ student_id: string }>("select student_id from public.ideas"));
    expect(ideas.rows.map((r) => r.student_id)).toEqual([s1]);
    const evaluations = await as(db, "authenticated", evA.userId, () =>
      db.query<{ student_id: string }>("select student_id from public.evaluations"),
    );
    expect(evaluations.rows.map((r) => r.student_id)).toEqual([s1]);
    const scores = await as(db, "authenticated", evA.userId, () => db.query("select * from public.evaluation_scores"));
    expect(scores.rows).toHaveLength(1);
    const mine = await as(db, "authenticated", evA.userId, () =>
      db.query<{ student_id: string }>("select student_id from public.my_evaluations"),
    );
    expect(mine.rows.map((r) => r.student_id)).toEqual([s1]);
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("select phone, gender from public.students")),
      "permission denied",
    );
  });

  it("evaluators cannot write tables directly or call admin functions", async () => {
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("update public.evaluations set total_score = 1")),
      "permission denied",
    );
    await rejectsWith(
      as(db, "authenticated", evA.userId, () =>
        db.query("insert into public.evaluation_scores (evaluation_id, criterion_id, score) select id, $1, 1 from public.evaluations", [criterion]),
      ),
      "permission denied",
    );
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("insert into public.domains (name) values ('x')")),
      "permission denied",
    );
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("select public.admin_release_evaluation(id, 'x') from public.evaluations")),
      "FORBIDDEN",
    );
    await rejectsWith(as(db, "authenticated", evA.userId, () => db.query("select public.dashboard_stats()")), "FORBIDDEN");
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("select public.import_students('[]'::jsonb)")),
      "permission denied",
    );
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("select public.claim_evaluation($1)", [s3])),
      "permission denied",
    );
    expect((await as(db, "authenticated", evA.userId, () => db.query("select * from public.audit_logs"))).rows).toEqual([]);
  });

  it("disabled evaluators lose access immediately", async () => {
    await db.query("update public.evaluators set status = 'DISABLED' where id = $1", [evA.evaluatorId]);
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("select * from public.search_students('23ad', 10)")),
      "FORBIDDEN",
    );
    expect((await as(db, "authenticated", evA.userId, () => db.query("select * from public.my_evaluations"))).rows).toEqual([]);
    await db.query("update public.evaluators set status = 'ACTIVE' where id = $1", [evA.evaluatorId]);
  });

  it("admins can read everything through the client role", async () => {
    expect((await as(db, "authenticated", adminId, () => db.query("select id from public.students"))).rows).toHaveLength(3);
    expect((await as(db, "authenticated", adminId, () => db.query("select * from public.evaluations"))).rows).toHaveLength(2);
    const stats = await as(db, "authenticated", adminId, () =>
      db.query<{ s: Record<string, number> }>("select public.dashboard_stats() as s"),
    );
    expect(stats.rows[0].s).toMatchObject({ total_students: 3, completed_evaluations: 1, in_progress_evaluations: 1, not_evaluated: 1 });
  });
});
