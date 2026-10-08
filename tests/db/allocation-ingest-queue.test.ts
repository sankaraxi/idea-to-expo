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

type Pair = { student_id: string; evaluator_id: string };

describe("confirm_allocation", () => {
  let db: PGlite;
  let adminId: string;
  let evaluators: { userId: string; evaluatorId: string }[];
  let students: string[];

  const confirm = (type: string, pairs: Pair[], max = 50, perStudent = 1) =>
    as(db, "authenticated", adminId, () =>
      db.query<{ r: { batch_id: string; assignment_count: number; replaced_count: number } }>(
        "select public.confirm_allocation($1, 'seed', $2, $3, $4::jsonb) as r",
        [type, max, perStudent, JSON.stringify(pairs)],
      ),
    ).then((res) => res.rows[0].r);

  beforeEach(async () => {
    db = await createTestDb();
    adminId = await createUser(db, "admin@example.edu", "ADMIN");
    evaluators = [await createEvaluator(db, "e1@x.edu"), await createEvaluator(db, "e2@x.edu")];
    students = [];
    for (let i = 1; i <= 4; i++) students.push(await createStudent(db, `S00${i}`));
  });

  it("commits all assignments and records a batch + audit entry", async () => {
    const pairs = students.map((s, i) => ({ student_id: s, evaluator_id: evaluators[i % 2].evaluatorId }));
    const r = await confirm("INITIAL", pairs);
    expect(r.assignment_count).toBe(4);
    const batch = await db.query<{ status: string; student_count: number }>(
      "select status, student_count from public.allocation_batches",
    );
    expect(batch.rows[0]).toMatchObject({ status: "CONFIRMED", student_count: 4 });
    const audit = await db.query("select * from public.audit_logs where action = 'ALLOCATION_CONFIRMED'");
    expect(audit.rows).toHaveLength(1);
  });

  it("rolls back everything when capacity would be exceeded", async () => {
    const pairs = students.map((s) => ({ student_id: s, evaluator_id: evaluators[0].evaluatorId }));
    await rejectsWith(confirm("INITIAL", pairs, 3), "CAPACITY_EXCEEDED");
    const rows = await db.query("select * from public.evaluation_assignments");
    expect(rows.rows).toEqual([]);
    const batches = await db.query("select * from public.allocation_batches");
    expect(batches.rows).toEqual([]);
  });

  it("respects per-evaluator individual caps", async () => {
    await db.query("update public.evaluators set max_assignments = 1 where id = $1", [evaluators[0].evaluatorId]);
    const pairs = students.slice(0, 2).map((s) => ({ student_id: s, evaluator_id: evaluators[0].evaluatorId }));
    await rejectsWith(confirm("INITIAL", pairs), "CAPACITY_EXCEEDED");
  });

  it("rejects duplicate student/evaluator pairs and over-assignment", async () => {
    await assign(db, students[0], evaluators[0].evaluatorId);
    await rejectsWith(
      confirm("INCREMENTAL", [{ student_id: students[0], evaluator_id: evaluators[0].evaluatorId }], 50, 2),
      "STALE_PREVIEW",
    );
    await rejectsWith(
      confirm("INCREMENTAL", [{ student_id: students[0], evaluator_id: evaluators[1].evaluatorId }], 50, 1),
      "STALE_PREVIEW",
    );
  });

  it("rejects plans that reference disabled evaluators or withdrawn students", async () => {
    await db.query("update public.evaluators set status = 'DISABLED' where id = $1", [evaluators[1].evaluatorId]);
    await rejectsWith(
      confirm("INITIAL", [{ student_id: students[0], evaluator_id: evaluators[1].evaluatorId }]),
      "STALE_PREVIEW",
    );
    await db.query("update public.students set status = 'WITHDRAWN' where id = $1", [students[1]]);
    await rejectsWith(
      confirm("INITIAL", [{ student_id: students[1], evaluator_id: evaluators[0].evaluatorId }]),
      "STALE_PREVIEW",
    );
  });

  it("full reallocation replaces only untouched assignments and keeps history", async () => {
    const pairs = students.map((s, i) => ({ student_id: s, evaluator_id: evaluators[i % 2].evaluatorId }));
    await confirm("INITIAL", pairs);
    await setEventStatus(db, "LIVE");
    const started = await db.query<{ id: string }>(
      "select id from public.evaluation_assignments where student_id = $1",
      [students[0]],
    );
    await as(db, "authenticated", evaluators[0].userId, () =>
      db.query("select public.submit_evaluation($1, 9, null)", [started.rows[0].id]),
    );

    // Swap evaluators for the three untouched students.
    const swapped = students.slice(1).map((s, i) => ({
      student_id: s,
      evaluator_id: evaluators[(i + 2) % 2 === 0 ? 0 : 1].evaluatorId,
    }));
    const r = await confirm("FULL_REALLOCATION", swapped);
    expect(r.replaced_count).toBe(3);

    const live = await db.query<{ n: number }>(
      "select count(*)::int as n from public.evaluation_assignments where status <> 'REPLACED'",
    );
    expect(live.rows[0].n).toBe(4);
    const replaced = await db.query<{ n: number }>(
      "select count(*)::int as n from public.evaluation_assignments where status = 'REPLACED'",
    );
    expect(replaced.rows[0].n).toBe(3);
    const completed = await db.query<{ status: string }>(
      "select status from public.evaluation_assignments where id = $1",
      [started.rows[0].id],
    );
    expect(completed.rows[0].status).toBe("COMPLETED");
    const batches = await db.query<{ status: string }>(
      "select status from public.allocation_batches order by created_at",
    );
    expect(batches.rows.map((b) => b.status).sort()).toEqual(["CONFIRMED", "REPLACED"]);
  });
});

describe("upsert_form_submissions", () => {
  let db: PGlite;

  const ingest = (rows: unknown[]) =>
    as(db, "service_role", null, () =>
      db.query<{ r: { inserted: number; updated: number; unchanged: number; skipped: number; status: string } }>(
        "select public.upsert_form_submissions($1::jsonb, 'APPS_SCRIPT') as r",
        [JSON.stringify(rows)],
      ),
    ).then((res) => res.rows[0].r);

  beforeEach(async () => {
    db = await createTestDb();
  });

  const row = (overrides: Record<string, unknown> = {}) => ({
    register_number: " 23ad001 ",
    name: "Asha",
    department: "AI&DS",
    year: "1",
    problem_statement: "Water",
    ppt_url: "https://drive.google.com/file/d/abc/view",
    submitted_at: "2026-10-01T10:00:00Z",
    ...overrides,
  });

  it("normalises register numbers and is idempotent on replay", async () => {
    expect(await ingest([row()])).toMatchObject({ inserted: 1, updated: 0, status: "SUCCESS" });
    expect(await ingest([row()])).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    const s = await db.query<{ register_number: string }>("select register_number from public.students");
    expect(s.rows).toEqual([{ register_number: "23AD001" }]);
    const ideas = await db.query("select * from public.ideas");
    expect(ideas.rows).toHaveLength(1);
  });

  it("applies newer submissions and ignores older ones", async () => {
    await ingest([row()]);
    expect(await ingest([row({ problem_statement: "Air", submitted_at: "2026-10-02T10:00:00Z" })])).toMatchObject({
      updated: 1,
    });
    expect(await ingest([row({ problem_statement: "Old", submitted_at: "2026-09-01T10:00:00Z" })])).toMatchObject({
      unchanged: 1,
    });
    const idea = await db.query<{ problem_statement: string }>("select problem_statement from public.ideas");
    expect(idea.rows[0].problem_statement).toBe("Air");
  });

  it("marks submissions without a PPT as incomplete", async () => {
    await ingest([row({ ppt_url: "" })]);
    const idea = await db.query<{ submission_status: string }>("select submission_status from public.ideas");
    expect(idea.rows[0].submission_status).toBe("INCOMPLETE");
  });

  it("records per-row errors without failing the batch", async () => {
    const r = await ingest([row(), row({ register_number: "" }), row({ register_number: "X1", year: "abc" })]);
    expect(r).toMatchObject({ inserted: 1, skipped: 2, status: "PARTIAL" });
    const runs = await db.query<{ status: string }>("select status from public.form_sync_runs");
    expect(runs.rows[0].status).toBe("PARTIAL");
  });
});

describe("sheet sync queue", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createTestDb();
  });

  const svc = <T>(fn: () => Promise<T>) => as(db, "service_role", null, fn);

  it("coalesces repeated changes into one pending job per entity", async () => {
    const id = await createStudent(db, "Q001");
    await db.query("update public.students set name = 'Renamed' where id = $1", [id]);
    await db.query("update public.students set name = 'Renamed again' where id = $1", [id]);
    const jobs = await db.query("select * from public.sheet_sync_queue where entity_type = 'STUDENT'");
    expect(jobs.rows).toHaveLength(1);
  });

  it("claims, completes and accepts new changes while a job is processing", async () => {
    const id = await createStudent(db, "Q002");
    const claimed = await svc(() =>
      db.query<{ id: string; status: string; attempts: number }>("select * from public.claim_sync_jobs(100)"),
    );
    expect(claimed.rows.length).toBeGreaterThan(0);
    expect(claimed.rows.every((j) => j.status === "PROCESSING" && j.attempts === 1)).toBe(true);

    // A change during processing creates a fresh PENDING job.
    await db.query("update public.students set name = 'Changed mid-flight' where id = $1", [id]);
    const pending = await db.query("select * from public.sheet_sync_queue where status = 'PENDING'");
    expect(pending.rows.length).toBeGreaterThan(0);

    await svc(() => db.query("select public.complete_sync_jobs($1::uuid[])", [claimed.rows.map((j) => j.id)]));
    const done = await db.query("select * from public.sheet_sync_queue where status = 'SUCCESS'");
    expect(done.rows).toHaveLength(claimed.rows.length);
  });

  it("backs off on failure, supersedes when newer work exists, and fails after max attempts", async () => {
    const id = await createStudent(db, "Q003");
    await db.query("delete from public.sheet_sync_queue where entity_type <> 'STUDENT'");

    let claimed = await svc(() => db.query<{ id: string }>("select id from public.claim_sync_jobs(10)"));
    await svc(() => db.query("select public.fail_sync_jobs($1::uuid[], 'Sheets 503', 2)", [[claimed.rows[0].id]]));
    let job = await db.query<{ status: string; last_error: string; due: boolean }>(
      "select status, last_error, next_retry_at > now() as due from public.sheet_sync_queue where id = $1",
      [claimed.rows[0].id],
    );
    expect(job.rows[0]).toMatchObject({ status: "PENDING", last_error: "Sheets 503", due: true });

    // Not due yet -> not claimable.
    claimed = await svc(() => db.query<{ id: string }>("select id from public.claim_sync_jobs(10)"));
    expect(claimed.rows).toEqual([]);

    await db.query("update public.sheet_sync_queue set next_retry_at = now() - interval '1 second'");
    claimed = await svc(() => db.query<{ id: string }>("select id from public.claim_sync_jobs(10)"));
    await svc(() => db.query("select public.fail_sync_jobs($1::uuid[], 'Sheets 503 again', 2)", [[claimed.rows[0].id]]));
    job = await db.query("select status from public.sheet_sync_queue where id = $1", [claimed.rows[0].id]);
    expect(job.rows[0]).toMatchObject({ status: "FAILED" });

    // Newer change exists -> a failing older job is superseded instead of re-queued.
    await db.query("update public.sheet_sync_queue set status = 'PENDING', attempts = 0, next_retry_at = now() where id = $1", [
      claimed.rows[0].id,
    ]);
    claimed = await svc(() => db.query<{ id: string }>("select id from public.claim_sync_jobs(10)"));
    await db.query("update public.students set name = 'Newer' where id = $1", [id]);
    await svc(() => db.query("select public.fail_sync_jobs($1::uuid[], 'boom', 5)", [[claimed.rows[0].id]]));
    job = await db.query("select status from public.sheet_sync_queue where id = $1", [claimed.rows[0].id]);
    expect(job.rows[0]).toMatchObject({ status: "SUPERSEDED" });
  });

  it("lease lock admits a single holder until released or expired", async () => {
    const acquire = (holder: string, ttl = 60) =>
      svc(() =>
        db.query<{ ok: boolean }>("select public.acquire_sync_lock('sheets', $1, $2) as ok", [holder, ttl]),
      ).then((r) => r.rows[0].ok);
    expect(await acquire("w1")).toBe(true);
    expect(await acquire("w2")).toBe(false);
    expect(await acquire("w1")).toBe(true); // re-entrant renew
    await svc(() => db.query("select public.release_sync_lock('sheets', 'w1')"));
    expect(await acquire("w2")).toBe(true);
    await db.query("update public.sync_locks set lease_until = now() - interval '1 second'");
    expect(await acquire("w3")).toBe(true);
  });
});
