import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  as,
  createCriterion,
  createDomain,
  createEvaluator,
  createStudent,
  createTestDb,
  createUser,
  rejectsWith,
  setEventStatus,
} from "./harness";

type Ev = { userId: string; evaluatorId: string };

describe("search-and-claim evaluation", () => {
  let db: PGlite;
  let evA: Ev;
  let evB: Ev;
  let student: string;
  let innovation: string;
  let feasibility: string;
  let genai: string;

  const submit = (u: string, s: string, scores: Record<string, unknown>, remarks: string | null = null, domains: string[] = []) =>
    as(db, "authenticated", u, () =>
      db.query<{ r: { duplicate: boolean; total_score: number; max_total: number; evaluation_id: string } }>(
        "select public.submit_evaluation($1, $2::jsonb, $3, $4::uuid[]) as r",
        [s, JSON.stringify(scores), remarks, domains],
      ),
    ).then((res) => res.rows[0].r);

  const draft = (u: string, s: string, scores: Record<string, unknown>, remarks: string | null = null, domains: string[] = []) =>
    as(db, "authenticated", u, () =>
      db.query<{ r: { version: number } }>("select public.save_evaluation_draft($1, $2::jsonb, $3, $4::uuid[]) as r", [
        s,
        JSON.stringify(scores),
        remarks,
        domains,
      ]),
    ).then((res) => res.rows[0].r);

  beforeEach(async () => {
    db = await createTestDb();
    evA = await createEvaluator(db, "a@example.edu");
    evB = await createEvaluator(db, "b@example.edu");
    student = await createStudent(db, "23CS001");
    innovation = await createCriterion(db, "Innovation", 10, "STARS");
    feasibility = await createCriterion(db, "Feasibility", 20);
    genai = await createDomain(db, "GenAI");
    await setEventStatus(db, "LIVE");
  });

  it("only accepts submissions while LIVE; drafts also while PAUSED", async () => {
    for (const status of ["NOT_STARTED", "PAUSED", "CLOSED"]) {
      await setEventStatus(db, status);
      await rejectsWith(submit(evA.userId, student, { [innovation]: 5, [feasibility]: 5 }), "EVENT_NOT_LIVE");
    }
    await setEventStatus(db, "PAUSED");
    await expect(draft(evA.userId, student, { [innovation]: 3 })).resolves.toMatchObject({ version: 2 });
    await setEventStatus(db, "CLOSED");
    await rejectsWith(draft(evA.userId, student, {}), "EVENT_NOT_LIVE");
  });

  it("validates every criterion score against its maximum", async () => {
    await rejectsWith(submit(evA.userId, student, { [innovation]: 5 }), "INCOMPLETE_SCORES");
    await rejectsWith(submit(evA.userId, student, { [innovation]: 11, [feasibility]: 5 }), "SCORE_OUT_OF_RANGE");
    await rejectsWith(submit(evA.userId, student, { [innovation]: -1, [feasibility]: 5 }), "SCORE_OUT_OF_RANGE");
    await rejectsWith(submit(evA.userId, student, { [innovation]: 7.5, [feasibility]: 5 }), "INVALID_SCORE");
    await rejectsWith(submit(evA.userId, student, { [innovation]: "7", [feasibility]: 5 }), "INVALID_SCORE");
    await rejectsWith(
      submit(evA.userId, student, { [innovation]: 7, [feasibility]: 5, "00000000-0000-0000-0000-000000000001": 1 }),
      "UNKNOWN_CRITERION",
    );
    await rejectsWith(submit(evA.userId, student, { [innovation]: 7, [feasibility]: 5 }, null, [crypto.randomUUID()]), "UNKNOWN_DOMAIN");
    // Nothing was claimed by the failed attempts.
    expect((await db.query("select * from public.evaluations")).rows).toEqual([]);
  });

  it("submits atomically with total, domains, audit and sheet jobs", async () => {
    const r = await submit(evA.userId, student, { [innovation]: 8, [feasibility]: 15 }, "  Strong idea ", [genai]);
    expect(r).toMatchObject({ total_score: 23, max_total: 30, duplicate: false });

    const ev = await db.query<{ status: string; remarks: string; total_score: number }>(
      "select status, remarks, total_score from public.evaluations",
    );
    expect(ev.rows[0]).toEqual({ status: "COMPLETED", remarks: "Strong idea", total_score: 23 });
    expect((await db.query("select * from public.evaluation_scores")).rows).toHaveLength(2);
    expect((await db.query("select * from public.evaluation_domains")).rows).toHaveLength(1);
    expect((await db.query("select * from public.audit_logs where action = 'EVALUATION_SUBMITTED'")).rows).toHaveLength(1);

    const jobs = await db.query<{ entity_type: string }>("select entity_type from public.sheet_sync_queue where status = 'PENDING'");
    expect(jobs.rows.map((j) => j.entity_type)).toEqual(
      expect.arrayContaining(["EVALUATION", "EVALUATOR", "RESULTS", "RESPONSE_ROW"]),
    );
  });

  it("allows only one evaluator per student", async () => {
    await draft(evA.userId, student, { [innovation]: 4 });
    await rejectsWith(draft(evB.userId, student, { [innovation]: 9 }), "STUDENT_TAKEN");
    await rejectsWith(submit(evB.userId, student, { [innovation]: 9, [feasibility]: 9 }), "STUDENT_TAKEN");
    const status = await as(db, "authenticated", evB.userId, () =>
      db.query<{ claim_status: string }>("select claim_status from public.search_students('23CS', 10)"),
    );
    expect(status.rows[0].claim_status).toBe("TAKEN");
  });

  it("enforces the per-evaluator cap (global and individual)", async () => {
    await db.query("update public.app_settings set max_evaluations_per_evaluator = 2 where id");
    const s2 = await createStudent(db, "23CS002");
    const s3 = await createStudent(db, "23CS003");
    await draft(evA.userId, student, {});
    await submit(evA.userId, s2, { [innovation]: 1, [feasibility]: 1 });
    await rejectsWith(draft(evA.userId, s3, {}), "EVALUATOR_LIMIT_REACHED");
    // Releasing an unsubmitted claim frees capacity.
    await as(db, "authenticated", evA.userId, () => db.query("select public.release_my_evaluation($1)", [student]));
    await expect(draft(evA.userId, s3, {})).resolves.toBeTruthy();

    await db.query("update public.app_settings set max_evaluations_per_evaluator = 50 where id");
    await db.query("update public.evaluators set max_evaluations = 1 where id = $1", [evB.evaluatorId]);
    await draft(evB.userId, student, {});
    await rejectsWith(draft(evB.userId, await createStudent(db, "23CS004"), {}), "EVALUATOR_LIMIT_REACHED");
  });

  it("treats an identical re-submit as a duplicate and blocks changes unless allowed", async () => {
    const scores = { [innovation]: 6, [feasibility]: 10 };
    await submit(evA.userId, student, scores, "ok", [genai]);
    expect(await submit(evA.userId, student, scores, "ok", [genai])).toMatchObject({ duplicate: true });
    await rejectsWith(submit(evA.userId, student, { ...scores, [feasibility]: 11 }, "ok", [genai]), "ALREADY_SUBMITTED");
    await rejectsWith(draft(evA.userId, student, scores), "ALREADY_SUBMITTED");
    await rejectsWith(
      as(db, "authenticated", evA.userId, () => db.query("select public.release_my_evaluation($1)", [student])),
      "ALREADY_SUBMITTED",
    );

    await db.query("update public.app_settings set allow_resubmission = true where id");
    expect(await submit(evA.userId, student, { ...scores, [feasibility]: 11 }, "ok", [])).toMatchObject({ total_score: 17 });
    expect((await db.query("select * from public.evaluation_domains")).rows).toEqual([]);
  });

  it("stores partial drafts and restores them through get_student_for_evaluation", async () => {
    await draft(evA.userId, student, { [innovation]: 3 }, "half done", [genai]);
    const detail = await as(db, "authenticated", evA.userId, () =>
      db.query<{ d: { claim_status: string; evaluation: { scores: Record<string, number>; domain_ids: string[]; remarks: string } } }>(
        "select public.get_student_for_evaluation($1) as d",
        [student],
      ),
    );
    expect(detail.rows[0].d.claim_status).toBe("MINE_IN_PROGRESS");
    expect(detail.rows[0].d.evaluation).toMatchObject({ scores: { [innovation]: 3 }, domain_ids: [genai], remarks: "half done" });
    // Drafts are private: nothing for the shared sheet yet.
    const jobs = await db.query("select * from public.sheet_sync_queue where entity_type in ('EVALUATION', 'RESPONSE_ROW')");
    expect(jobs.rows).toEqual([]);
  });

  it("lets an admin reopen or release an evaluation with a reason", async () => {
    const adminId = await createUser(db, "admin@example.edu", "ADMIN");
    const { evaluation_id } = await submit(evA.userId, student, { [innovation]: 2, [feasibility]: 2 });
    await rejectsWith(
      as(db, "authenticated", adminId, () => db.query("select public.admin_release_evaluation($1, '')", [evaluation_id])),
      "REASON_REQUIRED",
    );
    await as(db, "authenticated", adminId, () =>
      db.query("select public.admin_reopen_evaluation($1, 'Wrong scores')", [evaluation_id]),
    );
    expect((await db.query<{ status: string }>("select status from public.evaluations")).rows[0].status).toBe("IN_PROGRESS");

    await as(db, "authenticated", adminId, () =>
      db.query("select public.admin_release_evaluation($1, 'Reassign to a domain expert')", [evaluation_id]),
    );
    expect((await db.query("select * from public.evaluations")).rows).toEqual([]);
    const audit = await db.query<{ metadata: { scores: Record<string, number> } }>(
      "select metadata from public.audit_logs where action = 'EVALUATION_RELEASED'",
    );
    expect(audit.rows[0].metadata.scores).toMatchObject({ [innovation]: 2 });
    // Now another evaluator can take the student.
    await expect(draft(evB.userId, student, {})).resolves.toBeTruthy();
  });

  it("enforces criteria constraints", async () => {
    await rejectsWith(createCriterion(db, "Too many stars", 20, "STARS"), "evaluation_criteria_stars_max");
    await rejectsWith(createCriterion(db, " innovation ", 5), "duplicate key");
  });
});
