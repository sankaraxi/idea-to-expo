import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  as,
  createCriterion,
  createDomain,
  createEvaluator,
  createStudent,
  createTestDb,
  setEventStatus,
} from "./harness";

describe("import_students (CSV master data)", () => {
  let db: PGlite;
  const run = (rows: unknown[]) =>
    as(db, "service_role", null, () =>
      db.query<{ r: Record<string, number | string> }>("select public.import_students($1::jsonb) as r", [JSON.stringify(rows)]),
    ).then((x) => x.rows[0].r);

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("inserts, updates and is idempotent", async () => {
    const row = { _row: 2, register_number: "23ad 001", name: "Asha", gender: "Female", department: "AI&DS", email: "ASHA@x.edu", phone: "98" };
    expect(await run([row])).toMatchObject({ inserted: 1, status: "SUCCESS" });
    expect(await run([row])).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(await run([{ ...row, phone: "99" }])).toMatchObject({ updated: 1 });
    const s = await db.query("select register_number, gender, email, phone from public.students");
    expect(s.rows).toEqual([{ register_number: "23AD001", gender: "Female", email: "asha@x.edu", phone: "99" }]);
  });

  it("rejects rows whose email belongs to another student, without failing the batch", async () => {
    const r = await run([
      { _row: 2, register_number: "A1", name: "A", email: "same@x.edu" },
      { _row: 3, register_number: "A2", name: "B", email: "same@x.edu" },
      { _row: 4, register_number: "", name: "C" },
    ]);
    expect(r).toMatchObject({ inserted: 1, skipped: 2, status: "PARTIAL" });
  });
});

describe("upsert_form_submissions (problem statement responses)", () => {
  let db: PGlite;
  const ingest = (rows: unknown[]) =>
    as(db, "service_role", null, () =>
      db.query<{ r: Record<string, number | string> }>("select public.upsert_form_submissions($1::jsonb, 'APPS_SCRIPT') as r", [
        JSON.stringify(rows),
      ]),
    ).then((x) => x.rows[0].r);
  const response = (o: Record<string, unknown> = {}) => ({
    _row: 2,
    register_number: "23AD001",
    name: "Asha",
    email: "asha@x.edu",
    phone: "777",
    department: "AI&DS",
    section: "B",
    abstract: "Smart water meter",
    ppt_url: "https://drive.google.com/file/d/abc/view",
    submitted_at: "2026-10-01T10:00:00Z",
    ...o,
  });

  beforeEach(async () => {
    db = await createTestDb();
    await as(db, "service_role", null, () =>
      db.query("select public.import_students($1::jsonb)", [
        JSON.stringify([{ register_number: "23AD001", name: "Asha K", email: "asha@x.edu", phone: "111" }]),
      ]),
    );
  });

  it("matches by register number and only fills blank student fields", async () => {
    expect(await ingest([response()])).toMatchObject({ inserted: 1, status: "SUCCESS" });
    const s = await db.query("select name, phone, section, department from public.students");
    expect(s.rows[0]).toEqual({ name: "Asha K", phone: "111", section: "B", department: "AI&DS" });
    const i = await db.query("select abstract, matched_by, response_row, submission_status from public.ideas");
    expect(i.rows[0]).toEqual({ abstract: "Smart water meter", matched_by: "REGISTER_NUMBER", response_row: 2, submission_status: "SUBMITTED" });
    expect(await ingest([response()])).toMatchObject({ unchanged: 1 });
  });

  it("falls back to email when the register number on the form is wrong", async () => {
    await ingest([response({ register_number: "23AD0O1" })]);
    const i = await db.query<{ matched_by: string; other_details: Record<string, string> }>(
      "select matched_by, other_details from public.ideas",
    );
    expect(i.rows[0].matched_by).toBe("EMAIL");
    expect(i.rows[0].other_details["Register number on form"]).toBe("23AD0O1");
    expect((await db.query("select * from public.students")).rows).toHaveLength(1);
  });

  it("creates unmatched students (flagged) and never loses a response", async () => {
    await ingest([response({ register_number: "24ZZ999", email: "new@x.edu", name: "Newbie" })]);
    const i = await db.query<{ matched_by: string }>("select matched_by from public.ideas");
    expect(i.rows[0].matched_by).toBe("CREATED");
    expect(await ingest([response({ register_number: "", email: "ghost@x.edu" })])).toMatchObject({ skipped: 1 });
  });

  it("keeps the newest response and marks missing PPT as incomplete", async () => {
    await ingest([response()]);
    await ingest([response({ abstract: "Newer", ppt_url: "", submitted_at: "2026-10-02T10:00:00Z", _row: 5 })]);
    await ingest([response({ abstract: "Older", submitted_at: "2026-09-01T10:00:00Z" })]);
    const i = await db.query("select abstract, submission_status, response_row from public.ideas");
    expect(i.rows[0]).toEqual({ abstract: "Newer", submission_status: "INCOMPLETE", response_row: 5 });
  });
});

describe("sheet sync queue", () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await createTestDb();
  });
  const svc = <T>(fn: () => Promise<T>) => as(db, "service_role", null, fn);

  it("coalesces jobs, keeps mid-flight changes, backs off and fails after max attempts", async () => {
    const id = await createStudent(db, "Q001");
    await db.query("update public.students set name = 'Renamed' where id = $1", [id]);
    expect((await db.query("select * from public.sheet_sync_queue where entity_type = 'STUDENT'")).rows).toHaveLength(1);
    await db.query("delete from public.sheet_sync_queue where entity_type <> 'STUDENT'");

    let claimed = await svc(() => db.query<{ id: string }>("select id from public.claim_sync_jobs(10)"));
    await db.query("update public.students set name = 'Mid flight' where id = $1", [id]);
    expect((await db.query("select * from public.sheet_sync_queue where status = 'PENDING' and entity_type = 'STUDENT'")).rows).toHaveLength(1);
    // Newer pending job exists -> failing one is superseded.
    await svc(() => db.query("select public.fail_sync_jobs($1::uuid[], 'boom', 3)", [claimed.rows.map((r) => r.id)]));
    expect((await db.query<{ status: string }>("select status from public.sheet_sync_queue where id = $1", [claimed.rows[0].id])).rows[0].status).toBe(
      "SUPERSEDED",
    );

    claimed = await svc(() => db.query<{ id: string }>("select id from public.claim_sync_jobs(10)"));
    await svc(() => db.query("select public.fail_sync_jobs($1::uuid[], 'Sheets 503', 2)", [claimed.rows.map((r) => r.id)]));
    const job = await db.query<{ status: string; future: boolean }>(
      "select status, next_retry_at > now() as future from public.sheet_sync_queue where id = $1",
      [claimed.rows[0].id],
    );
    expect(job.rows[0]).toEqual({ status: "PENDING", future: true });
    expect((await svc(() => db.query("select * from public.claim_sync_jobs(10)"))).rows).toEqual([]);
    await db.query("update public.sheet_sync_queue set next_retry_at = now() - interval '1 second'");
    claimed = await svc(() => db.query<{ id: string }>("select id from public.claim_sync_jobs(10)"));
    await svc(() => db.query("select public.fail_sync_jobs($1::uuid[], 'again', 2)", [claimed.rows.map((r) => r.id)]));
    expect((await db.query<{ status: string }>("select status from public.sheet_sync_queue where id = $1", [claimed.rows[0].id])).rows[0].status).toBe(
      "FAILED",
    );
  });

  it("lease lock admits one holder", async () => {
    const acquire = (h: string) =>
      svc(() => db.query<{ ok: boolean }>("select public.acquire_sync_lock('sheets', $1, 60) as ok", [h])).then((r) => r.rows[0].ok);
    expect(await acquire("w1")).toBe(true);
    expect(await acquire("w2")).toBe(false);
    await svc(() => db.query("select public.release_sync_lock('sheets', 'w1')"));
    expect(await acquire("w2")).toBe(true);
  });

  it("releasing a completed evaluation queues the sheet rows to be cleared", async () => {
    const ev = await createEvaluator(db, "e@x.edu");
    const s = await createStudent(db, "R001");
    const c = await createCriterion(db, "Overall", 10);
    await setEventStatus(db, "LIVE");
    const { rows } = await as(db, "authenticated", ev.userId, () =>
      db.query<{ r: { evaluation_id: string } }>("select public.submit_evaluation($1, $2::jsonb, null, '{}') as r", [
        s,
        JSON.stringify({ [c]: 5 }),
      ]),
    );
    await db.query("delete from public.sheet_sync_queue");
    await db.query("delete from public.evaluations where id = $1", [rows[0].r.evaluation_id]);
    const jobs = await db.query<{ entity_type: string }>("select entity_type from public.sheet_sync_queue order by entity_type");
    expect(jobs.rows.map((j) => j.entity_type)).toEqual(["EVALUATION", "EVALUATOR", "RESPONSE_ROW", "RESULTS", "STUDENT"]);
  });
});

describe("reporting views", () => {
  it("summarise evaluations per student and evaluator", async () => {
    const db = await createTestDb();
    const e1 = await createEvaluator(db, "e1@x.edu", "E1");
    const sA = await createStudent(db, "A001");
    const sB = await createStudent(db, "B001");
    await createStudent(db, "C001");
    const c1 = await createCriterion(db, "Innovation", 10);
    const c2 = await createCriterion(db, "Impact", 10);
    const d = await createDomain(db, "AI/ML");
    await setEventStatus(db, "LIVE");
    await as(db, "authenticated", e1.userId, () =>
      db.query("select public.submit_evaluation($1, $2::jsonb, null, $3::uuid[])", [sA, JSON.stringify({ [c1]: 9, [c2]: 8 }), [d]]),
    );
    await as(db, "authenticated", e1.userId, () =>
      db.query("select public.save_evaluation_draft($1, $2::jsonb, null, '{}')", [sB, JSON.stringify({ [c1]: 3 })]),
    );

    const overview = await db.query<{ register_number: string; evaluation_status: string; total_score: number | null }>(
      "select register_number, evaluation_status, total_score from public.student_overview order by register_number",
    );
    expect(overview.rows).toEqual([
      { register_number: "A001", evaluation_status: "COMPLETED", total_score: 17 },
      { register_number: "B001", evaluation_status: "IN_PROGRESS", total_score: 3 },
      { register_number: "C001", evaluation_status: "NOT_EVALUATED", total_score: null },
    ]);
    const results = await db.query<{ register_number: string; domains: string; max_total: number }>(
      "select register_number, domains, max_total from public.student_results",
    );
    expect(results.rows).toEqual([{ register_number: "A001", domains: "AI/ML", max_total: 20 }]);
    const progress = await db.query<{ claimed_count: string; completed_count: string; evaluation_cap: number; average_percentage: string }>(
      "select claimed_count, completed_count, evaluation_cap, average_percentage from public.evaluator_progress",
    );
    expect(progress.rows[0]).toMatchObject({ evaluation_cap: 50, average_percentage: "85.0" });
    expect(Number(progress.rows[0].claimed_count)).toBe(2);
    const stats = await as(db, "service_role", null, () => db.query<{ s: Record<string, unknown> }>("select public.dashboard_stats() as s"));
    expect(stats.rows[0].s).toMatchObject({
      completed_evaluations: 1,
      in_progress_evaluations: 1,
      not_evaluated: 1,
      percentage_distribution: { "8": 1 },
      domain_counts: [{ domain: "AI/ML", count: 1 }],
    });
  });
});
