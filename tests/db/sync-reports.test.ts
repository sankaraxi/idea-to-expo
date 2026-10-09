import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { one, pool, run } from "@/lib/db/sql";
import { rankStudents } from "@/lib/results/ranking";
import { adminReleaseEvaluation, saveDraft, submitEvaluation } from "@/lib/services/evaluations";
import { listEvaluatorProgress } from "@/lib/services/evaluators";
import { getDashboardStats, getEvaluationOverviewsByIds, getStudentDetail, getSyncOverview, listAuditLogs, listEvaluations, listStudents, loadResultRows } from "@/lib/services/reports";
import {
  acquireSyncLock,
  claimSyncJobs,
  completeSyncJobs,
  enqueueFullResync,
  enqueueSync,
  failSyncJobs,
  releaseSyncLock,
  retryFailedSyncJobs,
} from "@/lib/services/sync-queue";
import { count, createAdmin, createCriterion, createDomain, createEvaluatorAccount, createStudent, createTestDb, hasMysql, select, setEventStatus, type TestDb } from "./harness";

describe.skipIf(!hasMysql)("sheet sync queue", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.drop();
  });

  const statusOf = async (id: string) => (await one<{ status: string }>(pool(), "SELECT status FROM sheet_sync_queue WHERE id = ?", [id]))!.status;

  it("claims due jobs once, completes them, and queues a fresh job for mid-flight changes", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    await enqueueSync(pool(), "STUDENT", id);
    const claimed = await claimSyncJobs(100);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ status: "PROCESSING", attempts: 1, entity_id: id });
    expect(await claimSyncJobs(100)).toEqual([]); // already processing

    await enqueueSync(pool(), "STUDENT", id); // change while the worker is busy
    expect(await count("sheet_sync_queue", "status = 'PENDING'")).toBe(1);

    await completeSyncJobs(claimed.map((j) => j.id));
    expect(await statusOf(claimed[0].id)).toBe("SUCCESS");
    expect(await claimSyncJobs(100)).toHaveLength(1); // the newer pending job is next
  });

  it("two workers claiming at once never receive the same job (SKIP LOCKED)", async () => {
    for (let i = 0; i < 40; i++) await enqueueSync(pool(), "STUDENT", `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const [a, b] = await Promise.all([claimSyncJobs(25), claimSyncJobs(25)]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length); // never handed out twice
    expect(ids.length).toBeGreaterThanOrEqual(25);
    // A row locked by the other worker's scan is merely deferred, never lost.
    const rest = await claimSyncJobs(100);
    expect(ids.length + rest.length).toBe(40);
    expect(new Set([...ids, ...rest.map((j) => j.id)]).size).toBe(40);
  });

  it("reclaims jobs whose worker died (stale PROCESSING)", async () => {
    await enqueueSync(pool(), "STUDENT", "22222222-2222-4222-8222-222222222222");
    await claimSyncJobs(10);
    await run(pool(), "UPDATE sheet_sync_queue SET locked_at = NOW(3) - INTERVAL 10 MINUTE");
    const again = await claimSyncJobs(10);
    expect(again).toHaveLength(1);
    expect(again[0].attempts).toBe(2);
  });

  it("backs off on failure, gives up after max attempts, and supersedes when newer work exists", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    await enqueueSync(pool(), "STUDENT", id);
    let [job] = await claimSyncJobs(10);
    await failSyncJobs([job.id], "Sheets 503", 2);
    const retry = await one<{ status: string; last_error: string; future: number }>(pool(), "SELECT status, last_error, next_retry_at > NOW(3) AS future FROM sheet_sync_queue WHERE id = ?", [job.id]);
    expect(retry).toMatchObject({ status: "PENDING", last_error: "Sheets 503", future: 1 });
    expect(await claimSyncJobs(10)).toEqual([]); // not due yet

    await run(pool(), "UPDATE sheet_sync_queue SET next_retry_at = NOW(3) - INTERVAL 1 SECOND");
    [job] = await claimSyncJobs(10);
    await failSyncJobs([job.id], "again", 2);
    expect(await statusOf(job.id)).toBe("FAILED");

    // retry puts it back…
    expect(await retryFailedSyncJobs()).toBe(1);
    [job] = await claimSyncJobs(10);
    // …and a newer pending twin supersedes a failing older job
    await enqueueSync(pool(), "STUDENT", id);
    await failSyncJobs([job.id], "boom", 5);
    expect(await statusOf(job.id)).toBe("SUPERSEDED");
  });

  it("retry re-queues each failed entity once", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    for (let i = 0; i < 2; i++) {
      await run(pool(), "INSERT INTO sheet_sync_queue (id, entity_type, entity_id, status) VALUES (UUID(), 'STUDENT', ?, 'FAILED')", [id]);
    }
    expect(await retryFailedSyncJobs()).toBe(1);
    expect(await count("sheet_sync_queue", "status = 'PENDING'")).toBe(1);
    expect(await count("sheet_sync_queue", "status = 'SUPERSEDED'")).toBe(1);
  });

  it("lease lock admits one holder until released or expired", async () => {
    expect(await acquireSyncLock("sheets", "w1", 60)).toBe(true);
    expect(await acquireSyncLock("sheets", "w2", 60)).toBe(false);
    expect(await acquireSyncLock("sheets", "w1", 60)).toBe(true); // renew
    await releaseSyncLock("sheets", "w2"); // not the holder: no effect
    expect(await acquireSyncLock("sheets", "w2", 60)).toBe(false);
    await releaseSyncLock("sheets", "w1");
    expect(await acquireSyncLock("sheets", "w2", 60)).toBe(true);
    await run(pool(), "UPDATE sync_locks SET lease_until = NOW(3) - INTERVAL 1 SECOND");
    expect(await acquireSyncLock("sheets", "w3", 60)).toBe(true);
  });

  it("a full resync queues every student, evaluator and completed evaluation", async () => {
    const ev = await createEvaluatorAccount("e@x.edu");
    const s1 = await createStudent("R001");
    await createStudent("R002");
    const c = await createCriterion("Overall", 10);
    await setEventStatus("LIVE");
    await submitEvaluation(ev.evaluatorId, { studentId: s1, scores: { [c]: 5 }, remarks: null, domainIds: [] });
    await run(pool(), "DELETE FROM sheet_sync_queue");
    const added = await enqueueFullResync(null);
    expect(added).toBe(2 + 1 + 1 + 1 + 1); // students, evaluator, evaluation, response row, results
    expect(await enqueueFullResync(null)).toBe(0); // idempotent
    expect(await count("audit_logs", "action = 'SHEET_FULL_RESYNC'")).toBe(2);
  });

  it("summarises the queue for the admin page", async () => {
    await enqueueSync(pool(), "STUDENT", "55555555-5555-4555-8555-555555555555");
    const overview = await getSyncOverview();
    expect(overview.counts).toMatchObject({ PENDING: 1, FAILED: 0 });
    expect(overview.workerActive).toBe(false);
    await acquireSyncLock("google_sheets", "w", 60);
    expect((await getSyncOverview()).workerActive).toBe(true);
  });
});

describe.skipIf(!hasMysql)("reports, dashboard and results", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.drop();
  });

  async function scenario() {
    const e1 = await createEvaluatorAccount("e1@x.edu", "E1");
    const e2 = await createEvaluatorAccount("e2@x.edu", "E2");
    const sA = await createStudent("A001", { department: "CSE" });
    const sB = await createStudent("B001", { department: "ECE" });
    const sC = await createStudent("C001", { department: "CSE" });
    const innovation = await createCriterion("Innovation", 10, "STARS", 1);
    const impact = await createCriterion("Impact", 10, "SLIDER", 2);
    const ai = await createDomain("AI/ML");
    const web = await createDomain("Full stack");
    await setEventStatus("LIVE");
    await submitEvaluation(e1.evaluatorId, { studentId: sA, scores: { [innovation]: 9, [impact]: 8 }, remarks: "great", domainIds: [ai, web] });
    await saveDraft(e1.evaluatorId, { studentId: sB, scores: { [innovation]: 3 }, remarks: null, domainIds: [] });
    await submitEvaluation(e2.evaluatorId, { studentId: sC, scores: { [innovation]: 5, [impact]: 5 }, remarks: null, domainIds: [ai] });
    return { e1, e2, sA, sB, sC, innovation, impact, ai, web };
  }

  it("computes dashboard statistics", async () => {
    await scenario();
    expect(await getDashboardStats()).toMatchObject({
      total_students: 3,
      total_evaluators: 2,
      completed_evaluations: 2,
      in_progress_evaluations: 1,
      not_evaluated: 0,
      average_percentage: 67.5,
      event_status: "LIVE",
      percentage_distribution: { "5": 1, "8": 1 },
      domain_counts: [{ domain: "AI/ML", count: 2 }, { domain: "Full stack", count: 1 }],
    });
    const stats = await getDashboardStats();
    expect(stats.department_progress).toEqual([
      { department: "CSE", students: 2, completed: 2 },
      { department: "ECE", students: 1, completed: 0 },
    ]);
    expect("evaluation_capacity" in stats).toBe(false);
  });

  it("lists evaluator progress without any limit/capacity", async () => {
    await scenario();
    const progress = await listEvaluatorProgress();
    expect(progress.map((p) => [p.name, p.claimed_count, p.completed_count, p.in_progress_count, p.average_percentage])).toEqual([
      ["E1", 2, 1, 1, 85],
      ["E2", 1, 1, 0, 50],
    ]);
    expect(Object.keys(progress[0]).some((k) => /cap|limit|max/i.test(k))).toBe(false);
  });

  it("filters and paginates the student list", async () => {
    await scenario();
    const base = { q: "", department: "", evaluation: "", submission: "", matched: "", status: "", page: 1 } as const;
    expect((await listStudents({ ...base })).total).toBe(3);
    expect((await listStudents({ ...base, q: "b00" })).rows.map((r) => r.register_number)).toEqual(["B001"]);
    expect((await listStudents({ ...base, department: "CSE" })).rows).toHaveLength(2);
    expect((await listStudents({ ...base, evaluation: "IN_PROGRESS" })).rows.map((r) => r.register_number)).toEqual(["B001"]);
    expect((await listStudents({ ...base, evaluation: "COMPLETED" })).rows.map((r) => r.evaluator_name)).toEqual(["E1", "E2"]);
    expect((await listStudents({ ...base, submission: "MISSING" })).rows).toEqual([]);
    await run(pool(), "DELETE FROM ideas WHERE student_id = (SELECT id FROM students WHERE register_number = 'A001')");
    expect((await listStudents({ ...base, submission: "MISSING" })).rows.map((r) => r.register_number)).toEqual(["A001"]);
    expect((await listStudents({ ...base, page: 2 }, 2)).rows).toHaveLength(1);
    expect((await listStudents({ ...base, q: "%" })).rows).toEqual([]); // wildcards are literal
  });

  it("lists evaluations with domains/scores and filters by domain and evaluator", async () => {
    const { e1, ai, web, innovation } = await scenario();
    const base = { evaluator: "", department: "", domain: "", q: "", status: "", page: 1 } as const;
    const all = await listEvaluations({ ...base });
    expect(all.total).toBe(3);
    const byDomain = await listEvaluations({ ...base, domain: web });
    expect(byDomain.rows).toHaveLength(1);
    expect(byDomain.rows[0]).toMatchObject({ register_number: "A001", domains: "AI/ML, Full stack", total_score: 17, evaluator_name: "E1" });
    expect(byDomain.rows[0].scores[innovation]).toBe(9);
    expect(byDomain.rows[0].domain_ids.sort()).toEqual([ai, web].sort());
    expect((await listEvaluations({ ...base, evaluator: e1.evaluatorId })).total).toBe(2);
    expect((await listEvaluations({ ...base, status: "IN_PROGRESS" })).rows.map((r) => r.register_number)).toEqual(["B001"]);
    expect((await getEvaluationOverviewsByIds([byDomain.rows[0].evaluation_id]))[0].scores).toEqual(byDomain.rows[0].scores);
  });

  it("builds ranked results from completed evaluations only (drafts excluded)", async () => {
    const { innovation } = await scenario();
    const results = await loadResultRows();
    expect(results.map((r) => r.register_number)).toEqual(["A001", "C001"]);
    const ranked = rankStudents(
      results.map((r) => ({ studentId: r.student_id, registerNumber: r.register_number, name: r.name, department: r.department, total: r.total_score, maxTotal: r.max_total, criterionScores: r.scores })),
      [`CRITERION:${innovation}`],
    );
    expect(ranked.map((r) => [r.registerNumber, r.rank, r.percentage])).toEqual([["A001", 1, 85], ["C001", 2, 50]]);
  });

  it("shows a student's evaluation detail, and releasing removes it from results", async () => {
    const { sA } = await scenario();
    const detail = await getStudentDetail(sA);
    expect(detail!.evaluation).toMatchObject({ evaluator_name: "E1", total_score: 17, status: "COMPLETED" });
    expect(detail!.criteria).toHaveLength(2);
    const admin = await createAdmin();
    await adminReleaseEvaluation(admin, detail!.evaluation!.evaluation_id, "reassign");
    expect((await getStudentDetail(sA))!.evaluation).toBeNull();
    expect((await loadResultRows()).map((r) => r.register_number)).toEqual(["C001"]);
  });

  it("lists audit entries with the acting user", async () => {
    await scenario();
    const { rows, total } = await listAuditLogs({ action: "EVALUATION_SUBMITTED", page: 1 });
    expect(total).toBe(2);
    expect(rows.map((r) => r.user_name).sort()).toEqual(["E1", "E2"]);
    expect(rows[0].user_role).toBe("EVALUATOR");
    expect((await listAuditLogs({ action: "NOPE", page: 1 })).total).toBe(0);
    void select;
  });
});
