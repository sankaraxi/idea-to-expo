import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool, run } from "@/lib/db/sql";
import { AppError } from "@/lib/errors";
import { getEvaluatorStats, getStudentForEvaluation, listMyEvaluations, saveDraft, searchStudents, submitEvaluation } from "@/lib/services/evaluations";
import { count, createCriterion, createEvaluatorAccount, createStudent, createTestDb, hasMysql, rejectsWith, setEventStatus, type TestDb } from "./harness";

type Ev = Awaited<ReturnType<typeof createEvaluatorAccount>>;

describe.skipIf(!hasMysql)("evaluator isolation (application-level authorization)", () => {
  let db: TestDb;
  let a: Ev;
  let b: Ev;
  let c1: string;
  let s1: string;
  let s2: string;
  let s3: string;

  beforeEach(async () => {
    db = await createTestDb();
    a = await createEvaluatorAccount("a@example.edu", "Evaluator A");
    b = await createEvaluatorAccount("b@example.edu", "Evaluator B");
    s1 = await createStudent("23AD001", { name: "Asha" });
    s2 = await createStudent("23AD002", { name: "Bala" });
    s3 = await createStudent("23AD003", { name: "Chitra" });
    c1 = await createCriterion("Overall", 10);
    await setEventStatus("LIVE");
    await saveDraft(a.evaluatorId, { studentId: s1, scores: { [c1]: 4 }, remarks: "A private notes", domainIds: [] });
    await submitEvaluation(b.evaluatorId, { decision: "SELECTED", studentId: s2, scores: { [c1]: 7 }, remarks: "B private remarks", domainIds: [] });
  });
  afterEach(async () => {
    await db.drop();
  });

  it("search shows every active student with a claim status from the caller's point of view", async () => {
    const hits = await searchStudents(a.evaluatorId, "23ad", 10);
    expect(hits.map((h) => [h.register_number, h.claim_status])).toEqual([
      ["23AD001", "MINE_IN_PROGRESS"],
      ["23AD002", "TAKEN"],
      ["23AD003", "AVAILABLE"],
    ]);
    const bHits = await searchStudents(b.evaluatorId, "23ad", 10);
    expect(bHits.map((h) => h.claim_status)).toEqual(["TAKEN", "MINE_COMPLETED", "AVAILABLE"]);
  });

  it("finds students by register number prefix, name and email, exact register number first", async () => {
    await createStudent("23AD0010", { name: "Other" });
    expect((await searchStudents(a.evaluatorId, "23ad001", 10)).map((h) => h.register_number)).toEqual(["23AD001", "23AD0010"]);
    expect((await searchStudents(a.evaluatorId, " 23 AD 003 ", 10)).map((h) => h.register_number)).toEqual(["23AD003"]);
    expect((await searchStudents(a.evaluatorId, "chit", 10)).map((h) => h.register_number)).toEqual(["23AD003"]);
    expect((await searchStudents(a.evaluatorId, "23ad002@", 10)).map((h) => h.register_number)).toEqual(["23AD002"]);
    expect(await searchStudents(a.evaluatorId, "2", 10)).toEqual([]);
  });

  it("treats SQL wildcards and injection attempts in the query as plain text", async () => {
    expect(await searchStudents(a.evaluatorId, "%%", 10)).toEqual([]);
    expect(await searchStudents(a.evaluatorId, "__", 10)).toEqual([]);
    expect(await searchStudents(a.evaluatorId, "' OR '1'='1", 10)).toEqual([]);
    expect(await searchStudents(a.evaluatorId, "x'; DROP TABLE students; --", 10)).toEqual([]);
    expect(await count("students")).toBe(3);
  });

  it("hides withdrawn students from search and detail", async () => {
    await run(pool(), "UPDATE students SET status = 'WITHDRAWN' WHERE id = ?", [s3]);
    expect((await searchStudents(a.evaluatorId, "23ad", 10)).map((h) => h.register_number)).toEqual(["23AD001", "23AD002"]);
    expect(await getStudentForEvaluation(a.evaluatorId, s3)).toBeNull();
  });

  it("never reveals another evaluator's scores, remarks or identity", async () => {
    const detail = await getStudentForEvaluation(a.evaluatorId, s2);
    expect(detail!.claim_status).toBe("TAKEN");
    expect(detail!.evaluation).toBeNull();
    const text = JSON.stringify(detail) + JSON.stringify(await searchStudents(a.evaluatorId, "23AD002", 5));
    for (const secret of ["B private remarks", "Evaluator B", b.evaluatorId, b.userId, "b@example.edu"]) expect(text).not.toContain(secret);
  });

  it("returns only minimal student fields (no phone / gender)", async () => {
    const detail = await getStudentForEvaluation(a.evaluatorId, s1);
    expect(Object.keys(detail!.student).sort()).toEqual(["department", "email", "id", "name", "register_number", "section", "year"]);
    expect(JSON.stringify(detail)).not.toContain("9999999999");
  });

  it("lists and counts only the caller's own evaluations", async () => {
    expect((await listMyEvaluations(a.evaluatorId)).map((r) => r.register_number)).toEqual(["23AD001"]);
    expect((await listMyEvaluations(b.evaluatorId)).map((r) => r.register_number)).toEqual(["23AD002"]);
    expect(await getEvaluatorStats(a.evaluatorId)).toMatchObject({ completed: 0, inProgress: 1, unclaimedStudents: 1, eventTotal: 3, eventCompleted: 1 });
  });

  it("an evaluator cannot overwrite or submit for a student someone else holds", async () => {
    await rejectsWith(saveDraft(a.evaluatorId, { studentId: s2, scores: { [c1]: 1 }, remarks: "hijack", domainIds: [] }), "STUDENT_TAKEN");
    await rejectsWith(submitEvaluation(a.evaluatorId, { decision: "SELECTED", studentId: s2, scores: { [c1]: 1 }, remarks: null, domainIds: [] }), "STUDENT_TAKEN");
    expect(await count("evaluations", "student_id = ? AND total_score = 7", [s2])).toBe(1);
  });
});

describe.skipIf(!hasMysql)("concurrent claims", () => {
  let db: TestDb;
  let a: Ev;
  let b: Ev;
  let c1: string;

  beforeEach(async () => {
    db = await createTestDb();
    a = await createEvaluatorAccount("a@example.edu");
    b = await createEvaluatorAccount("b@example.edu");
    c1 = await createCriterion("Overall", 10);
    await setEventStatus("LIVE");
  });
  afterEach(async () => {
    await db.drop();
  });

  const claim = (ev: Ev, studentId: string) => saveDraft(ev.evaluatorId, { studentId, scores: { [c1]: 5 }, remarks: null, domainIds: [] });

  it("two evaluators racing for the same students: exactly one wins each", async () => {
    const students = await Promise.all(Array.from({ length: 12 }, (_, i) => createStudent(`RACE${String(i).padStart(2, "0")}`)));
    const results = await Promise.allSettled(students.flatMap((s) => [claim(a, s), claim(b, s)]));

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(students.length);
    expect(rejected).toHaveLength(students.length);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(AppError);
    for (const r of rejected) expect((r.reason as AppError).code).toBe("STUDENT_TAKEN");
    expect(await count("evaluations")).toBe(students.length);
  });

  it("a double-clicked submit stores one evaluation and one audit entry", async () => {
    const student = await createStudent("DBL001");
    const submit = () => submitEvaluation(a.evaluatorId, { decision: "SELECTED", studentId: student, scores: { [c1]: 8 }, remarks: "good", domainIds: [] });
    const [first, second] = await Promise.all([submit(), submit()]);
    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
    expect(first.evaluationId).toBe(second.evaluationId);
    expect(await count("evaluations")).toBe(1);
    expect(await count("evaluation_scores")).toBe(1);
    expect(await count("audit_logs", "action = 'EVALUATION_SUBMITTED'")).toBe(1);
  });

  it("many concurrent drafts by different evaluators on different students never deadlock", async () => {
    const students = await Promise.all(Array.from({ length: 30 }, (_, i) => createStudent(`PAR${String(i).padStart(2, "0")}`)));
    const results = await Promise.allSettled(students.map((s, i) => claim(i % 2 ? a : b, s)));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await count("evaluations")).toBe(30);
    expect(await count("evaluations", "evaluator_id = ?", [a.evaluatorId])).toBe(15);
  });
});
