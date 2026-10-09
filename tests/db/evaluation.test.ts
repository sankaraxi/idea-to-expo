import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { one, pool, run } from "@/lib/db/sql";
import {
  adminReleaseEvaluation,
  adminReopenEvaluation,
  getStudentForEvaluation,
  releaseMyEvaluation,
  saveDraft,
  searchStudents,
  submitEvaluation,
} from "@/lib/services/evaluations";
import {
  count,
  createAdmin,
  createCriterion,
  createDomain,
  createEvaluatorAccount,
  createStudent,
  createTestDb,
  hasMysql,
  rejectsWith,
  select,
  setEventStatus,
  type TestDb,
} from "./harness";

type Ev = Awaited<ReturnType<typeof createEvaluatorAccount>>;

describe.skipIf(!hasMysql)("search-and-claim evaluation", () => {
  let db: TestDb;
  let evA: Ev;
  let evB: Ev;
  let student: string;
  let innovation: string;
  let feasibility: string;
  let genai: string;

  const submit = (ev: Ev, studentId: string, scores: Record<string, unknown>, remarks: string | null = null, domainIds: string[] = []) =>
    submitEvaluation(ev.evaluatorId, { studentId, scores, remarks, domainIds });
  const draft = (ev: Ev, studentId: string, scores: Record<string, unknown>, remarks: string | null = null, domainIds: string[] = []) =>
    saveDraft(ev.evaluatorId, { studentId, scores, remarks, domainIds });

  beforeEach(async () => {
    db = await createTestDb();
    evA = await createEvaluatorAccount("a@example.edu", "Evaluator A");
    evB = await createEvaluatorAccount("b@example.edu", "Evaluator B");
    student = await createStudent("23CS001");
    innovation = await createCriterion("Innovation", 10, "STARS", 1);
    feasibility = await createCriterion("Feasibility", 20, "SLIDER", 2);
    genai = await createDomain("GenAI");
    await setEventStatus("LIVE");
  });
  afterEach(async () => {
    await db.drop();
  });

  it("only accepts submissions while LIVE; drafts also while PAUSED", async () => {
    for (const status of ["NOT_STARTED", "PAUSED", "CLOSED"]) {
      await setEventStatus(status);
      await rejectsWith(submit(evA, student, { [innovation]: 5, [feasibility]: 5 }), "EVENT_NOT_LIVE");
    }
    await setEventStatus("PAUSED");
    await expect(draft(evA, student, { [innovation]: 3 }, "partial")).resolves.toMatchObject({ version: 2 });
    await setEventStatus("CLOSED");
    await rejectsWith(draft(evA, student, {}), "EVENT_NOT_LIVE");
    await setEventStatus("NOT_STARTED");
    await rejectsWith(draft(evA, student, {}), "EVENT_NOT_LIVE");
  });

  it("validates every score against its criterion and claims nothing on failure", async () => {
    const bad = (scores: Record<string, unknown>) => submit(evA, student, scores);
    await rejectsWith(bad({ [innovation]: 5 }), "INCOMPLETE_SCORES");
    await rejectsWith(bad({ [innovation]: 11, [feasibility]: 5 }), "SCORE_OUT_OF_RANGE");
    await rejectsWith(bad({ [innovation]: 5, [feasibility]: 21 }), "SCORE_OUT_OF_RANGE");
    await rejectsWith(bad({ [innovation]: -1, [feasibility]: 5 }), "SCORE_OUT_OF_RANGE");
    await rejectsWith(bad({ [innovation]: 7.5, [feasibility]: 5 }), "INVALID_SCORE");
    await rejectsWith(bad({ [innovation]: "7", [feasibility]: 5 }), "INVALID_SCORE");
    await rejectsWith(bad({ [innovation]: 7, [feasibility]: 5, "00000000-0000-0000-0000-000000000001": 1 }), "UNKNOWN_CRITERION");
    await rejectsWith(bad({ "not-a-uuid": 7, [feasibility]: 5 }), "UNKNOWN_CRITERION");
    await rejectsWith(submit(evA, student, { [innovation]: 7, [feasibility]: 5 }, null, ["00000000-0000-0000-0000-000000000009"]), "UNKNOWN_DOMAIN");
    await rejectsWith(submit(evA, student, { [innovation]: 7, [feasibility]: 5 }, "x".repeat(5001)), "REMARKS_TOO_LONG");
    expect(await count("evaluations")).toBe(0);
  });

  it("rejects submissions when no criteria exist and ignores inactive criteria", async () => {
    await run(pool(), "UPDATE evaluation_criteria SET is_active = 0 WHERE id = ?", [feasibility]);
    // Only Innovation is active now.
    await expect(submit(evA, student, { [innovation]: 6 })).resolves.toMatchObject({ totalScore: 6, maxTotal: 10 });
    await run(pool(), "UPDATE evaluation_criteria SET is_active = 0");
    await rejectsWith(submit(evB, await createStudent("23CS002"), {}), "NO_CRITERIA");
    await rejectsWith(submit(evB, await createStudent("23CS003"), { [feasibility]: 3 }), "UNKNOWN_CRITERION");
  });

  it("submits atomically: evaluation, scores, domains, audit trail and sheet jobs", async () => {
    const r = await submit(evA, student, { [innovation]: 8, [feasibility]: 15 }, "  Strong idea ", [genai]);
    expect(r).toMatchObject({ totalScore: 23, maxTotal: 30, duplicate: false });

    expect(await one(pool(), "SELECT status, remarks, total_score, max_total FROM evaluations")).toEqual({
      status: "COMPLETED", remarks: "Strong idea", total_score: 23, max_total: 30,
    });
    expect(await count("evaluation_scores")).toBe(2);
    expect(await count("evaluation_domains")).toBe(1);

    const audit = await select<{ user_id: string; metadata: { total: number; evaluator_id: string } }>("SELECT user_id, metadata FROM audit_logs WHERE action = 'EVALUATION_SUBMITTED'");
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(evA.userId);
    expect(audit[0].metadata).toMatchObject({ total: 23, evaluator_id: evA.evaluatorId });

    const jobs = (await select<{ entity_type: string }>("SELECT entity_type FROM sheet_sync_queue WHERE status = 'PENDING'")).map((j) => j.entity_type);
    expect(jobs).toEqual(expect.arrayContaining(["EVALUATION", "EVALUATOR", "RESULTS", "RESPONSE_ROW", "STUDENT"]));
  });

  it("allows only one evaluator per student", async () => {
    await draft(evA, student, { [innovation]: 4 });
    await rejectsWith(draft(evB, student, { [innovation]: 9 }), "STUDENT_TAKEN");
    await rejectsWith(submit(evB, student, { [innovation]: 9, [feasibility]: 9 }), "STUDENT_TAKEN");
    const [hit] = await searchStudents(evB.evaluatorId, "23CS", 10);
    expect(hit.claim_status).toBe("TAKEN");
    expect(await count("evaluations")).toBe(1);
  });

  it("has NO per-evaluator limit: one evaluator can take well over 50 students", async () => {
    const total = 60;
    for (let i = 1; i <= total; i++) {
      const id = await createStudent(`BULK${String(i).padStart(3, "0")}`);
      await draft(evA, id, { [innovation]: 1 });
    }
    expect(await count("evaluations", "evaluator_id = ?", [evA.evaluatorId])).toBe(total);
    const last = await createStudent("BULK999");
    await expect(submit(evA, last, { [innovation]: 5, [feasibility]: 5 })).resolves.toMatchObject({ duplicate: false });
  });

  it("treats an identical re-submit as a no-op and blocks changes unless resubmission is allowed", async () => {
    const scores = { [innovation]: 6, [feasibility]: 10 };
    const first = await submit(evA, student, scores, "ok", [genai]);
    const again = await submit(evA, student, scores, "ok", [genai]);
    expect(again).toMatchObject({ duplicate: true, evaluationId: first.evaluationId });
    expect(await count("audit_logs", "action = 'EVALUATION_SUBMITTED'")).toBe(1);

    await rejectsWith(submit(evA, student, { ...scores, [feasibility]: 11 }, "ok", [genai]), "ALREADY_SUBMITTED");
    await rejectsWith(draft(evA, student, scores), "ALREADY_SUBMITTED");

    await run(pool(), "UPDATE app_settings SET allow_resubmission = 1 WHERE id = 1");
    expect(await submit(evA, student, { ...scores, [feasibility]: 11 }, "ok", [])).toMatchObject({ totalScore: 17, duplicate: false });
    expect(await count("evaluation_domains")).toBe(0);
    expect(await one(pool(), "SELECT version FROM evaluations")).toEqual({ version: 3 });
    expect(await count("audit_logs", "action = 'EVALUATION_UPDATED'")).toBe(1);
  });

  it("stores partial drafts, restores them, and keeps drafts private from the sheet", async () => {
    await draft(evA, student, { [innovation]: 3 }, "half done", [genai]);
    const second = await draft(evA, student, { [innovation]: 4, [feasibility]: 8 }, "more", [genai]);
    expect(second.version).toBe(3);

    const detail = await getStudentForEvaluation(evA.evaluatorId, student);
    expect(detail!.claim_status).toBe("MINE_IN_PROGRESS");
    expect(detail!.evaluation).toMatchObject({ scores: { [innovation]: 4, [feasibility]: 8 }, domain_ids: [genai], remarks: "more", status: "IN_PROGRESS" });

    const jobs = (await select<{ entity_type: string }>("SELECT entity_type FROM sheet_sync_queue")).map((j) => j.entity_type);
    expect(jobs).not.toContain("EVALUATION");
    expect(jobs).not.toContain("RESPONSE_ROW");
  });

  it("rejects a disabled evaluator even with a stale session", async () => {
    await run(pool(), "UPDATE evaluators SET status = 'DISABLED' WHERE id = ?", [evA.evaluatorId]);
    await rejectsWith(draft(evA, student, { [innovation]: 3 }), "NOT_AN_EVALUATOR");
    await rejectsWith(submit(evA, student, { [innovation]: 3, [feasibility]: 3 }), "NOT_AN_EVALUATOR");
  });

  it("lets an evaluator release their own unsubmitted draft, freeing the student", async () => {
    await draft(evA, student, { [innovation]: 3 });
    await rejectsWith(releaseMyEvaluation(evB.evaluatorId, student), "EVALUATION_NOT_FOUND");
    await releaseMyEvaluation(evA.evaluatorId, student);
    expect(await count("evaluations")).toBe(0);
    await expect(draft(evB, student, { [innovation]: 5 })).resolves.toBeTruthy();

    const other = await createStudent("23CS002");
    await submit(evA, other, { [innovation]: 5, [feasibility]: 5 });
    await rejectsWith(releaseMyEvaluation(evA.evaluatorId, other), "ALREADY_SUBMITTED");
  });

  it("lets an admin reopen or release an evaluation, with a mandatory reason and an audit trail", async () => {
    const adminId = await createAdmin();
    const { evaluationId } = await submit(evA, student, { [innovation]: 2, [feasibility]: 2 }, "meh");
    await rejectsWith(adminReopenEvaluation(adminId, evaluationId, "  "), "REASON_REQUIRED");
    await rejectsWith(adminReleaseEvaluation(adminId, evaluationId, ""), "REASON_REQUIRED");
    await rejectsWith(adminReopenEvaluation(adminId, "00000000-0000-0000-0000-00000000dead", "x"), "EVALUATION_NOT_FOUND");

    await adminReopenEvaluation(adminId, evaluationId, "Scored the wrong student");
    expect(await one(pool(), "SELECT status, submitted_at FROM evaluations")).toEqual({ status: "IN_PROGRESS", submitted_at: null });
    await rejectsWith(adminReopenEvaluation(adminId, evaluationId, "again"), "EVALUATION_NOT_COMPLETED");
    await submit(evA, student, { [innovation]: 6, [feasibility]: 6 });
    expect(await one(pool(), "SELECT total_score, status FROM evaluations")).toEqual({ total_score: 12, status: "COMPLETED" });

    await adminReleaseEvaluation(adminId, evaluationId, "Reassign to a domain expert");
    expect(await count("evaluations")).toBe(0);
    expect(await count("evaluation_scores")).toBe(0);
    const [log] = await select<{ metadata: { reason: string; scores: Record<string, number>; total: number; by: string } }>(
      "SELECT metadata FROM audit_logs WHERE action = 'EVALUATION_RELEASED'",
    );
    expect(log.metadata).toMatchObject({ reason: "Reassign to a domain expert", by: "admin", total: 12, scores: { [innovation]: 6 } });
    await expect(draft(evB, student, {})).resolves.toBeTruthy();
  });

  it("queues sheet jobs so the response row is cleared when an evaluation is released", async () => {
    const adminId = await createAdmin();
    const { evaluationId } = await submit(evA, student, { [innovation]: 2, [feasibility]: 2 });
    await run(pool(), "DELETE FROM sheet_sync_queue");
    await adminReleaseEvaluation(adminId, evaluationId, "reassign");
    const jobs = (await select<{ entity_type: string; entity_id: string }>("SELECT entity_type, entity_id FROM sheet_sync_queue")).map((j) => j.entity_type);
    expect(jobs).toEqual(expect.arrayContaining(["EVALUATION", "RESPONSE_ROW", "RESULTS", "EVALUATOR", "STUDENT"]));
  });

  it("does not claim withdrawn students", async () => {
    await run(pool(), "UPDATE students SET status = 'WITHDRAWN' WHERE id = ?", [student]);
    await rejectsWith(draft(evA, student, { [innovation]: 3 }), "STUDENT_NOT_FOUND");
    await rejectsWith(draft(evA, "00000000-0000-0000-0000-00000000dead", {}), "STUDENT_NOT_FOUND");
  });
});
