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
  return unwrap(await db.rpc("dashboard_stats")).data as unknown as DashboardStats;
}

export async function getEvaluatorProgress() {
  const db = await adminDb();
  return unwrap(await db.from("evaluator_progress").select("*").order("name")).data;
}

export async function getDepartments(): Promise<string[]> {
  const db = await adminDb();
  const { data } = unwrap(await db.from("students").select("department").not("department", "is", null).limit(5000));
  return [...new Set(data.map((d) => d.department as string))].sort();
}

export async function getCriteria() {
  const db = await adminDb();
  return unwrap(await db.from("evaluation_criteria").select("*").order("sort_order").order("name")).data;
}

export async function getDomains() {
  const db = await adminDb();
  return unwrap(await db.from("domains").select("*").order("sort_order").order("name")).data;
}

/** Usage counts so the UI can explain why a criterion/domain cannot be deleted. */
export async function getCriteriaUsage() {
  const db = await adminDb();
  const [scores, domains] = await Promise.all([
    db.from("evaluation_scores").select("criterion_id").limit(100000),
    db.from("evaluation_domains").select("domain_id").limit(100000),
  ]);
  const count = (ids: string[]) => ids.reduce<Record<string, number>>((m, id) => ((m[id] = (m[id] ?? 0) + 1), m), {});
  return {
    criteria: count((scores.data ?? []).map((r) => r.criterion_id)),
    domains: count((domains.data ?? []).map((r) => r.domain_id)),
  };
}

export interface StudentFilters {
  q: string;
  department: string;
  evaluation: "" | "NOT_EVALUATED" | "IN_PROGRESS" | "COMPLETED";
  submission: "" | "SUBMITTED" | "INCOMPLETE" | "MISSING";
  matched: "" | "CREATED" | "EMAIL";
  status: string;
  page: number;
}

export async function listStudents(f: StudentFilters, pageSize = 50) {
  const db = await adminDb();
  let query = db.from("student_overview").select("*", { count: "exact" });
  const q = searchTerm(f.q);
  if (q) query = query.or(`register_number.ilike.%${q}%,name.ilike.%${q}%,email.ilike.%${q}%`);
  if (f.department) query = query.eq("department", f.department);
  if (f.submission) query = query.eq("submission_status", f.submission);
  if (f.evaluation) query = query.eq("evaluation_status", f.evaluation);
  if (f.matched) query = query.eq("matched_by", f.matched);
  if (f.status) query = query.eq("status", f.status as "ACTIVE");
  const from = (f.page - 1) * pageSize;
  const result = unwrap(await query.order("register_number").range(from, from + pageSize - 1));
  return { rows: result.data, total: result.count };
}

export async function getStudentDetail(id: string) {
  const db = await adminDb();
  const [student, idea, evaluation, criteria] = await Promise.all([
    db.from("students").select("*").eq("id", id).maybeSingle(),
    db.from("ideas").select("*").eq("student_id", id).maybeSingle(),
    db.from("evaluation_overview").select("*").eq("student_id", id).maybeSingle(),
    db.from("evaluation_criteria").select("*").order("sort_order").order("name"),
  ]);
  if (student.error) throw new Error(student.error.message);
  if (!student.data) return null;
  return { student: student.data, idea: idea.data, evaluation: evaluation.data, criteria: criteria.data ?? [] };
}

export interface EvaluationFilters {
  evaluator: string;
  department: string;
  domain: string;
  q: string;
  status: "" | "IN_PROGRESS" | "COMPLETED";
  page: number;
}

export async function listEvaluations(f: EvaluationFilters, pageSize = 50) {
  const db = await adminDb();
  let query = db.from("evaluation_overview").select("*", { count: "exact" });
  if (f.evaluator) query = query.eq("evaluator_id", f.evaluator);
  if (f.department) query = query.eq("department", f.department);
  if (f.domain) query = query.contains("domain_ids", [f.domain]);
  const q = searchTerm(f.q);
  if (q) query = query.or(`register_number.ilike.%${q}%,student_name.ilike.%${q}%`);
  if (f.status) query = query.eq("status", f.status);
  const result = unwrap(
    await query.order("updated_at", { ascending: false }).range((f.page - 1) * pageSize, f.page * pageSize - 1),
  );
  return { rows: result.data, total: result.count };
}

export async function getEvaluatorOptions() {
  const db = await adminDb();
  return unwrap(await db.from("evaluators").select("id, name, status").order("name")).data;
}

export async function getResults() {
  const db = await adminDb();
  const [ranked, settings, criteria] = await Promise.all([
    loadRankedResults(db),
    db.from("app_settings").select("tie_breakers").single(),
    db.from("evaluation_criteria").select("id, name, max_marks, is_active, sort_order").order("sort_order").order("name"),
  ]);
  return { ranked, tieBreakers: unwrap(settings).data.tie_breakers, criteria: criteria.data ?? [] };
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
  const userIds = [...new Set(result.data.map((r) => r.user_id).filter((v): v is string => !!v))];
  const profiles = userIds.length
    ? ((await db.from("profiles").select("id, full_name, email, role").in("id", userIds)).data ?? [])
    : [];
  return { rows: result.data, total: result.count, profiles };
}

export async function getFullSettings() {
  const db = await adminDb();
  return unwrap(await db.from("app_settings").select("*").single()).data;
}
