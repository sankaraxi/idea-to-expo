import { describe, expect, it } from "vitest";
import { rankStudents } from "@/lib/results/ranking";
import { as, assign, createEvaluator, createStudent, createTestDb, setEventStatus } from "./harness";

describe("reporting views", () => {
  it("compute per-student state, multi-evaluator averages and evaluator progress", async () => {
    const db = await createTestDb();
    const e1 = await createEvaluator(db, "e1@x.edu", "E1");
    const e2 = await createEvaluator(db, "e2@x.edu", "E2");
    const sA = await createStudent(db, "A001");
    const sB = await createStudent(db, "B001");
    await createStudent(db, "C001"); // unassigned
    const a1 = await assign(db, sA, e1.evaluatorId);
    const a2 = await assign(db, sA, e2.evaluatorId);
    const a3 = await assign(db, sB, e1.evaluatorId);
    await setEventStatus(db, "LIVE");
    const submit = (u: string, id: string, score: number) =>
      as(db, "authenticated", u, () => db.query("select public.submit_evaluation($1, $2, null)", [id, score]));
    await submit(e1.userId, a1, 9);
    await submit(e2.userId, a2, 8);
    await as(db, "authenticated", e1.userId, () => db.query("select public.save_evaluation_draft($1, 3, null)", [a3]));

    const overview = await db.query<{ register_number: string; evaluation_state: string; average_score: string | null }>(
      "select register_number, evaluation_state, average_score from public.student_overview order by register_number",
    );
    expect(overview.rows).toEqual([
      { register_number: "A001", evaluation_state: "COMPLETED", average_score: "8.50" },
      { register_number: "B001", evaluation_state: "PENDING", average_score: null },
      { register_number: "C001", evaluation_state: "UNASSIGNED", average_score: null },
    ]);

    const results = await db.query<{ register_number: string; scores: number[] | null; evaluation_count: string }>(
      "select register_number, scores, evaluation_count from public.student_results order by register_number",
    );
    // Drafts never count towards results.
    expect(results.rows.map((r) => [r.register_number, r.scores, Number(r.evaluation_count)])).toEqual([
      ["A001", [9, 8], 2],
      ["B001", null, 0],
      ["C001", null, 0],
    ]);
    const { ranked } = rankStudents(
      results.rows.map((r) => ({ studentId: r.register_number, registerNumber: r.register_number, name: "", department: null, scores: r.scores ?? [] })),
      { tieBreakers: ["MIN_SCORE_DESC"] },
    );
    expect(ranked).toMatchObject([{ registerNumber: "A001", rank: 1, finalScore: 8.5 }]);

    const progress = await db.query<{ name: string; assigned_count: string; completed_count: string; in_progress_count: string }>(
      "select name, assigned_count, completed_count, in_progress_count from public.evaluator_progress order by name",
    );
    expect(progress.rows.map((p) => [p.name, Number(p.assigned_count), Number(p.completed_count), Number(p.in_progress_count)])).toEqual([
      ["E1", 2, 1, 1],
      ["E2", 1, 1, 0],
    ]);

    const stats = await as(db, "service_role", null, () =>
      db.query<{ s: Record<string, unknown> }>("select public.dashboard_stats() as s"),
    );
    expect(stats.rows[0].s).toMatchObject({
      total_students: 3,
      assigned_students: 2,
      total_assignments: 3,
      completed_evaluations: 2,
      in_progress_evaluations: 1,
      pending_evaluations: 0,
      score_distribution: { "8": 1, "9": 1 },
    });
  });
});
