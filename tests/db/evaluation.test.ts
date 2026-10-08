import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
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

describe("evaluation RPCs", () => {
  let db: PGlite;
  let evA: { userId: string; evaluatorId: string };
  let evB: { userId: string; evaluatorId: string };
  let studentId: string;
  let assignmentId: string;

  const submit = (userId: string, id: string, score: number | null, remarks: string | null = null) =>
    as(db, "authenticated", userId, () =>
      db.query<{ r: { duplicate: boolean; evaluation_id: string } }>(
        "select public.submit_evaluation($1, $2, $3) as r",
        [id, score, remarks],
      ),
    ).then((res) => res.rows[0].r);

  const draft = (userId: string, id: string, score: number | null, remarks: string | null = null) =>
    as(db, "authenticated", userId, () =>
      db.query<{ r: { version: number } }>("select public.save_evaluation_draft($1, $2, $3) as r", [
        id,
        score,
        remarks,
      ]),
    ).then((res) => res.rows[0].r);

  beforeEach(async () => {
    db = await createTestDb();
    evA = await createEvaluator(db, "a@example.edu");
    evB = await createEvaluator(db, "b@example.edu");
    studentId = await createStudent(db, "23CS001");
    assignmentId = await assign(db, studentId, evA.evaluatorId);
    await setEventStatus(db, "LIVE");
  });

  it("rejects submission unless the event is LIVE", async () => {
    for (const status of ["NOT_STARTED", "PAUSED", "CLOSED"]) {
      await setEventStatus(db, status);
      await rejectsWith(submit(evA.userId, assignmentId, 8), "EVENT_NOT_LIVE");
    }
  });

  it("allows drafts while PAUSED but not when CLOSED", async () => {
    await setEventStatus(db, "PAUSED");
    await expect(draft(evA.userId, assignmentId, 6, "partial")).resolves.toMatchObject({ version: 1 });
    await setEventStatus(db, "CLOSED");
    await rejectsWith(draft(evA.userId, assignmentId, 6), "EVENT_NOT_LIVE");
  });

  it.each([0, 11, -3, null])("rejects invalid score %s", async (score) => {
    await rejectsWith(submit(evA.userId, assignmentId, score), "INVALID_SCORE");
  });

  it("rejects decimal scores at the type level", async () => {
    await rejectsWith(
      as(db, "authenticated", evA.userId, () =>
        db.query("select public.submit_evaluation($1, '7.5', null)", [assignmentId]),
      ),
      /invalid input syntax|integer/,
    );
  });

  it("prevents evaluating another evaluator's assignment", async () => {
    await rejectsWith(submit(evB.userId, assignmentId, 9), "ASSIGNMENT_NOT_FOUND");
    await rejectsWith(draft(evB.userId, assignmentId, 9), "ASSIGNMENT_NOT_FOUND");
  });

  it("submits atomically: evaluation, assignment status, audit log and sync queue", async () => {
    const result = await submit(evA.userId, assignmentId, 8, "  Good implementation  ");
    expect(result.duplicate).toBe(false);

    const ev = await db.query<{ score: number; remarks: string; status: string; submitted_at: string | null }>(
      "select score, remarks, status, submitted_at from public.evaluations where assignment_id = $1",
      [assignmentId],
    );
    expect(ev.rows[0]).toMatchObject({ score: 8, remarks: "Good implementation", status: "COMPLETED" });
    expect(ev.rows[0].submitted_at).not.toBeNull();

    const a = await db.query<{ status: string }>("select status from public.evaluation_assignments where id = $1", [
      assignmentId,
    ]);
    expect(a.rows[0].status).toBe("COMPLETED");

    const audit = await db.query("select * from public.audit_logs where action = 'EVALUATION_SUBMITTED'");
    expect(audit.rows).toHaveLength(1);

    const queue = await db.query<{ entity_type: string }>(
      "select entity_type from public.sheet_sync_queue where status = 'PENDING'",
    );
    expect(queue.rows.map((r) => r.entity_type)).toEqual(
      expect.arrayContaining(["ASSIGNMENT", "EVALUATION", "EVALUATOR", "RESULTS"]),
    );
  });

  it("treats an identical re-submission as a no-op duplicate", async () => {
    const first = await submit(evA.userId, assignmentId, 8, "ok");
    const second = await submit(evA.userId, assignmentId, 8, "ok");
    expect(second).toMatchObject({ duplicate: true, evaluation_id: first.evaluation_id });
    const rows = await db.query("select * from public.evaluations");
    expect(rows.rows).toHaveLength(1);
  });

  it("blocks changing a submitted evaluation unless resubmission is allowed", async () => {
    await submit(evA.userId, assignmentId, 8);
    await rejectsWith(submit(evA.userId, assignmentId, 9), "ALREADY_SUBMITTED");
    await rejectsWith(draft(evA.userId, assignmentId, 9), "ALREADY_SUBMITTED");

    await db.query("update public.app_settings set allow_resubmission = true where id");
    await submit(evA.userId, assignmentId, 9, "revised");
    const ev = await db.query<{ score: number; version: number }>("select score, version from public.evaluations");
    expect(ev.rows[0]).toMatchObject({ score: 9, version: 2 });
    const audit = await db.query("select * from public.audit_logs where action = 'EVALUATION_UPDATED'");
    expect(audit.rows).toHaveLength(1);
  });

  it("persists drafts and marks the assignment in progress", async () => {
    await draft(evA.userId, assignmentId, null, "thinking");
    const second = await draft(evA.userId, assignmentId, 7, "thinking more");
    expect(second.version).toBe(2);
    const ev = await db.query<{ score: number; status: string; remarks: string }>(
      "select score, status, remarks from public.evaluations",
    );
    expect(ev.rows[0]).toMatchObject({ score: 7, status: "IN_PROGRESS", remarks: "thinking more" });
    const a = await db.query<{ status: string }>("select status from public.evaluation_assignments");
    expect(a.rows[0].status).toBe("IN_PROGRESS");
    // Drafts are private: they are not pushed to the shared sheet.
    const q = await db.query("select * from public.sheet_sync_queue where entity_type = 'EVALUATION'");
    expect(q.rows).toEqual([]);
  });

  it("lets an admin reopen a completed evaluation with a reason", async () => {
    const adminId = await createUser(db, "admin@example.edu", "ADMIN");
    const { evaluation_id } = await submit(evA.userId, assignmentId, 4);

    await rejectsWith(
      as(db, "authenticated", adminId, () =>
        db.query("select public.admin_reopen_evaluation($1, '')", [evaluation_id]),
      ),
      "REASON_REQUIRED",
    );
    await as(db, "authenticated", adminId, () =>
      db.query("select public.admin_reopen_evaluation($1, 'Scored the wrong student')", [evaluation_id]),
    );
    const ev = await db.query<{ status: string }>("select status from public.evaluations");
    expect(ev.rows[0].status).toBe("IN_PROGRESS");

    await submit(evA.userId, assignmentId, 6);
    const after = await db.query<{ score: number; status: string }>("select score, status from public.evaluations");
    expect(after.rows[0]).toMatchObject({ score: 6, status: "COMPLETED" });
  });
});
