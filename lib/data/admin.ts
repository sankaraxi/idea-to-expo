import "server-only";
import { requireAdminPage } from "@/lib/auth/session";
import { searchTerm } from "@/lib/format";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadRankedResults } from "@/lib/sheets/worker";
import type { DashboardStats } from "@/types/database";

/**
 * Admin read models. Every function authorises first: layouts and pages
 * render in parallel, so a layout-level check alone would not stop a page's
 * service-role query from running.
 */
async function adminDb() {
  await requireAdminPage();
  return createAdminClient();
}

function unwrap<T>(result: { data: T; error: { message: string } | null; count?: number | null }) {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("Expected data but received none");
  return { data: result.data as NonNullable<T>, count: result.count ?? 0 };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const db = await adminDb();
  const { data } = unwrap(await db.rpc("dashboard_stats"));
  return data as unknown as DashboardStats;
}

export async function getEvaluatorProgress() {
  const db = await adminDb();
  return unwrap(await db.from("evaluator_progress").select("*").order("name")).data ?? [];
}

export async function getDepartments(): Promise<string[]> {
  const db = await adminDb();
  const { data } = unwrap(await db.from("students").select("department").not("department", "is", null).limit(5000));
  return [...new Set((data ?? []).map((d) => d.department as string))].sort();
}

export interface StudentFilters {
  q: string;
  department: string;
  evaluation: "" | "UNASSIGNED" | "PENDING" | "COMPLETED";
  submission: "" | "SUBMITTED" | "INCOMPLETE" | "MISSING";
  status: string;
  page: number;
}

export async function listStudents(f: StudentFilters, pageSize = 50) {
  const db = await adminDb();
  let query = db.from("student_overview").select("*", { count: "exact" });
  const q = searchTerm(f.q);
  if (q) query = query.or(`register_number.ilike.%${q}%,name.ilike.%${q}%`);
  if (f.department) query = query.eq("department", f.department);
  if (f.submission) query = query.eq("submission_status", f.submission);
  if (f.status) query = query.eq("status", f.status as "ACTIVE");
  if (f.evaluation) query = query.eq("evaluation_state", f.evaluation);
  const from = (f.page - 1) * pageSize;
  const result = unwrap(await query.order("register_number").range(from, from + pageSize - 1));
  return { rows: result.data ?? [], total: result.count };
}

export async function getStudentDetail(id: string) {
  const db = await adminDb();
  const [student, idea, assignments] = await Promise.all([
    db.from("students").select("*").eq("id", id).maybeSingle(),
    db.from("ideas").select("*").eq("student_id", id).maybeSingle(),
    db
      .from("evaluation_assignments")
      .select("id, evaluator_id, status, assigned_at, completed_at, allocation_batch_id")
      .eq("student_id", id)
      .order("assigned_at"),
  ]);
  if (student.error) throw new Error(student.error.message);
  if (!student.data) return null;
  const evaluatorIds = [...new Set((assignments.data ?? []).map((a) => a.evaluator_id))];
  const [evaluators, evaluations] = await Promise.all([
    evaluatorIds.length ? db.from("evaluators").select("id, name, email").in("id", evaluatorIds) : { data: [] },
    db.from("evaluations").select("*").eq("student_id", id),
  ]);
  return {
    student: student.data,
    idea: idea.data,
    assignments: (assignments.data ?? []).map((a) => ({
      ...a,
      evaluator: (evaluators.data ?? []).find((e) => e.id === a.evaluator_id) ?? null,
      evaluation: (evaluations.data ?? []).find((e) => e.assignment_id === a.id) ?? null,
    })),
  };
}

export interface EvaluationFilters {
  evaluator: string;
  department: string;
  q: string;
  status: "" | "PENDING" | "IN_PROGRESS" | "COMPLETED";
  minScore: number | null;
  maxScore: number | null;
  page: number;
}

export async function listEvaluations(f: EvaluationFilters, pageSize = 50) {
  const db = await adminDb();
  let query = db.from("evaluation_overview").select("*", { count: "exact" });
  if (f.evaluator) query = query.eq("evaluator_id", f.evaluator);
  if (f.department) query = query.eq("department", f.department);
  const q = searchTerm(f.q);
  if (q) query = query.or(`register_number.ilike.%${q}%,student_name.ilike.%${q}%`);
  if (f.status) query = query.eq("assignment_status", f.status);
  if (f.minScore !== null) query = query.gte("score", f.minScore);
  if (f.maxScore !== null) query = query.lte("score", f.maxScore);
  const from = (f.page - 1) * pageSize;
  const result = unwrap(
    await query.order("evaluation_updated_at", { ascending: false, nullsFirst: false }).order("register_number").range(from, from + pageSize - 1),
  );
  return { rows: result.data ?? [], total: result.count };
}

export async function getEvaluatorOptions() {
  const db = await adminDb();
  return unwrap(await db.from("evaluators").select("id, name, status").order("name")).data ?? [];
}

export async function getResults() {
  const db = await adminDb();
  const [ranked, settings] = await Promise.all([
    loadRankedResults(db),
    db.from("app_settings").select("tie_breakers, evaluators_per_student").single(),
  ]);
  return { ranked, settings: unwrap(settings).data };
}

export async function getAllocationOverview() {
  const db = await adminDb();
  const [settings, students, evaluators, live, batches] = await Promise.all([
    db.from("app_settings").select("max_per_evaluator, evaluators_per_student, event_status").single(),
    db.from("students").select("id", { count: "exact", head: true }).eq("status", "ACTIVE"),
    db.from("evaluators").select("max_assignments").eq("status", "ACTIVE"),
    db.from("evaluation_assignments").select("id", { count: "exact", head: true }).neq("status", "REPLACED"),
    db.from("allocation_batches").select("*").order("created_at", { ascending: false }).limit(20),
  ]);
  return {
    settings: unwrap(settings).data,
    activeStudents: students.count ?? 0,
    evaluatorCaps: (evaluators.data ?? []).map((e) => e.max_assignments),
    liveAssignments: live.count ?? 0,
    batches: unwrap(batches).data ?? [],
  };
}

export async function getSyncOverview() {
  const db = await adminDb();
  const counts = await Promise.all(
    (["PENDING", "PROCESSING", "SUCCESS", "FAILED", "SUPERSEDED"] as const).map(async (status) => {
      const { count } = await db.from("sheet_sync_queue").select("id", { count: "exact", head: true }).eq("status", status);
      return [status, count ?? 0] as const;
    }),
  );
  const [failed, recent, formRuns, lastSuccess, lock] = await Promise.all([
    db.from("sheet_sync_queue").select("*").eq("status", "FAILED").order("created_at", { ascending: false }).limit(50),
    db.from("sheet_sync_queue").select("*").order("created_at", { ascending: false }).limit(30),
    db.from("form_sync_runs").select("*").order("created_at", { ascending: false }).limit(15),
    db.from("sheet_sync_queue").select("processed_at").eq("status", "SUCCESS").order("processed_at", { ascending: false }).limit(1),
    db.from("sync_locks").select("*").eq("name", "google_sheets").maybeSingle(),
  ]);
  return {
    counts: Object.fromEntries(counts) as Record<"PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "SUPERSEDED", number>,
    failed: failed.data ?? [],
    recent: recent.data ?? [],
    formRuns: formRuns.data ?? [],
    lastSuccessAt: lastSuccess.data?.[0]?.processed_at ?? null,
    workerActive: !!lock.data && new Date(lock.data.lease_until).getTime() > Date.now(),
  };
}

export async function listAuditLogs(f: { action: string; page: number }, pageSize = 50) {
  const db = await adminDb();
  let query = db.from("audit_logs").select("*", { count: "exact" });
  if (f.action) query = query.eq("action", f.action);
  const from = (f.page - 1) * pageSize;
  const result = unwrap(await query.order("created_at", { ascending: false }).range(from, from + pageSize - 1));
  const userIds = [...new Set((result.data ?? []).map((r) => r.user_id).filter((v): v is string => !!v))];
  const profiles = userIds.length
    ? (await db.from("profiles").select("id, full_name, email, role").in("id", userIds)).data ?? []
    : [];
  return { rows: result.data ?? [], total: result.count, profiles };
}

export async function getFullSettings() {
  const db = await adminDb();
  return unwrap(await db.from("app_settings").select("*").single()).data;
}
