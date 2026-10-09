import "server-only";
import { escapeLike, one, pool, rows, rowsIn, type Queryable } from "@/lib/db/sql";
import type { Decision } from "@/lib/decision";
import type {
  AuditLogWithUser,
  CriterionRow,
  DashboardStats,
  EvaluationOverviewRow,
  EventStatus,
  FormSyncRunRow,
  IdeaRow,
  StudentOverviewRow,
  StudentResultRow,
  StudentRow,
  SyncJobRow,
} from "@/types/database";
import { isSyncWorkerActive } from "./sync-queue";

const num = (v: unknown) => Number(v ?? 0);

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function getDashboardStats(db: Queryable = pool()): Promise<DashboardStats> {
  const [students, ideas, evaluators, evals, notEvaluated, distribution, domains, departments, settings, sync, lastForm, decisions] = await Promise.all([

    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM students WHERE status = 'ACTIVE'"),
    one<{ submitted: number; incomplete: number; unmatched: number }>(
      db,
      `SELECT COALESCE(SUM(i.submission_status = 'SUBMITTED'), 0) AS submitted,
              COALESCE(SUM(i.submission_status = 'INCOMPLETE'), 0) AS incomplete,
              COALESCE(SUM(i.matched_by = 'CREATED'), 0) AS unmatched
         FROM ideas i JOIN students s ON s.id = i.student_id WHERE s.status = 'ACTIVE'`,
    ),
    one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM evaluators WHERE status = 'ACTIVE'"),
    one<{ completed: number; in_progress: number; average: number | null }>(
      db,
      `SELECT COALESCE(SUM(status = 'COMPLETED'), 0) AS completed,
              COALESCE(SUM(status = 'IN_PROGRESS'), 0) AS in_progress,
              ROUND(AVG(CASE WHEN status = 'COMPLETED' AND max_total > 0 THEN 100 * total_score / max_total END), 1) AS average
         FROM evaluations`,
    ),
    one<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM students s WHERE s.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM evaluations e WHERE e.student_id = s.id)",
    ),
    rows<{ bucket: number; n: number }>(
      db,
      `SELECT LEAST(FLOOR(100 * total_score / max_total / 10), 9) AS bucket, COUNT(*) AS n
         FROM evaluations WHERE status = 'COMPLETED' AND max_total > 0 GROUP BY bucket`,
    ),
    rows<{ domain: string; n: number }>(
      db,
      `SELECT d.name AS domain, COUNT(*) AS n
         FROM evaluation_domains ed
         JOIN domains d ON d.id = ed.domain_id
         JOIN evaluations e ON e.id = ed.evaluation_id AND e.status = 'COMPLETED'
        GROUP BY d.id, d.name ORDER BY n DESC, d.name`,
    ),
    rows<{ department: string; students: number; completed: number }>(
      db,
      `SELECT COALESCE(s.department, 'Unknown') AS department, COUNT(*) AS students,
              COALESCE(SUM(e.status = 'COMPLETED'), 0) AS completed
         FROM students s LEFT JOIN evaluations e ON e.student_id = s.id
        WHERE s.status = 'ACTIVE' GROUP BY COALESCE(s.department, 'Unknown') ORDER BY department`,
    ),
    one<{ event_status: EventStatus }>(db, "SELECT event_status FROM app_settings WHERE id = 1"),
    one<{ pending: number; failed: number; last_sync_at: string | null }>(
      db,
      `SELECT COALESCE(SUM(status IN ('PENDING', 'PROCESSING')), 0) AS pending,
              COALESCE(SUM(status = 'FAILED'), 0) AS failed,
              MAX(CASE WHEN status = 'SUCCESS' THEN processed_at END) AS last_sync_at
         FROM sheet_sync_queue`,
    ),
    one<{ at: string | null }>(db, "SELECT MAX(created_at) AS at FROM form_sync_runs"),
    rows<{ decision: Decision | null; n: number }>(db, "SELECT decision, COUNT(*) AS n FROM evaluations WHERE status = 'COMPLETED' GROUP BY decision"),
  ]);
  const decisionCounts = { SELECTED: 0, WAITLISTED: 0, REJECTED: 0, NOT_SET: 0 };
  for (const d of decisions) decisionCounts[d.decision ?? "NOT_SET"] += num(d.n);

  return {
    total_students: num(students?.n),
    ideas_submitted: num(ideas?.submitted),
    ideas_incomplete: num(ideas?.incomplete),
    unmatched_submissions: num(ideas?.unmatched),
    total_evaluators: num(evaluators?.n),
    completed_evaluations: num(evals?.completed),
    in_progress_evaluations: num(evals?.in_progress),
    not_evaluated: num(notEvaluated?.n),
    decision_counts: decisionCounts,
    average_percentage: evals?.average === null || evals?.average === undefined ? null : Number(evals.average),
    percentage_distribution: Object.fromEntries(distribution.map((d) => [String(d.bucket), num(d.n)])),
    domain_counts: domains.map((d) => ({ domain: d.domain, count: num(d.n) })),
    department_progress: departments.map((d) => ({ department: d.department, students: num(d.students), completed: num(d.completed) })),
    event_status: settings?.event_status ?? "NOT_STARTED",
    sync_pending: num(sync?.pending),
    sync_failed: num(sync?.failed),
    last_sync_at: sync?.last_sync_at ?? null,
    last_form_sync_at: lastForm?.at ?? null,
  };
}

export async function listDepartments(): Promise<string[]> {
  const list = await rows<{ department: string }>(pool(), "SELECT DISTINCT department FROM students WHERE department IS NOT NULL ORDER BY department");
  return list.map((d) => d.department);
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

export interface StudentFilters {
  q: string;
  department: string;
  evaluation: "" | "NOT_EVALUATED" | "IN_PROGRESS" | "COMPLETED";
  submission: "" | "SUBMITTED" | "INCOMPLETE" | "MISSING";
  matched: "" | "CREATED" | "EMAIL";
  status: string;
  page: number;
}

/** Collects WHERE clauses and their parameters. */
class Filter {
  private clauses: string[] = [];
  readonly params: unknown[] = [];
  add(clause: string, ...values: unknown[]) {
    this.clauses.push(clause);
    this.params.push(...values);
  }
  get sql() {
    return this.clauses.length ? ` WHERE ${this.clauses.join(" AND ")}` : "";
  }
}

const STUDENT_OVERVIEW_SQL = `
  SELECT s.id, s.register_number, s.name, s.gender, s.department, s.section, s.email, s.status, s.source,
         s.created_at, s.updated_at,
         COALESCE(i.submission_status, 'MISSING') AS submission_status, i.ppt_url, i.matched_by,
         COALESCE(ev.status, 'NOT_EVALUATED') AS evaluation_status,
         ev.id AS evaluation_id, ev.decision, ev.total_score, ev.max_total, ee.name AS evaluator_name
    FROM students s
    LEFT JOIN ideas i ON i.student_id = s.id
    LEFT JOIN evaluations ev ON ev.student_id = s.id
    LEFT JOIN evaluators ee ON ee.id = ev.evaluator_id`;

export async function listStudents(f: StudentFilters, pageSize = 50) {
  const filter = new Filter();
  const q = f.q.trim().slice(0, 100);
  if (q) {
    const like = `%${escapeLike(q)}%`;
    filter.add("(s.register_number LIKE ? OR s.name LIKE ? OR s.email LIKE ?)", like, like, like);
  }
  if (f.department) filter.add("s.department = ?", f.department);
  if (f.submission === "MISSING") filter.add("i.id IS NULL");
  else if (f.submission) filter.add("i.submission_status = ?", f.submission);
  if (f.evaluation === "NOT_EVALUATED") filter.add("ev.id IS NULL");
  else if (f.evaluation) filter.add("ev.status = ?", f.evaluation);
  if (f.matched) filter.add("i.matched_by = ?", f.matched);
  if (f.status) filter.add("s.status = ?", f.status);
  const clause = filter.sql;
  const params = filter.params;

  const [list, count] = await Promise.all([
    rows<StudentOverviewRow>(pool(), `${STUDENT_OVERVIEW_SQL}${clause} ORDER BY s.register_number LIMIT ? OFFSET ?`, [
      ...params,
      pageSize,
      (f.page - 1) * pageSize,
    ]),
    one<{ n: number }>(
      pool(),
      `SELECT COUNT(*) AS n FROM students s LEFT JOIN ideas i ON i.student_id = s.id LEFT JOIN evaluations ev ON ev.student_id = s.id${clause}`,
      params,
    ),
  ]);
  return { rows: list, total: num(count?.n) };
}

export const getStudentOverviewsByIds = (ids: readonly string[]) =>
  rowsIn<StudentOverviewRow>(pool(), ids, (ph) => `${STUDENT_OVERVIEW_SQL} WHERE s.id IN ${ph}`);

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

const EVALUATION_OVERVIEW_SQL = `
  SELECT ev.id AS evaluation_id, ev.status, ev.decision, ev.total_score, ev.max_total, ev.remarks, ev.started_at, ev.submitted_at, ev.updated_at,
         s.id AS student_id, s.register_number, s.name AS student_name, s.department,
         e.id AS evaluator_id, e.name AS evaluator_name,
         (SELECT GROUP_CONCAT(d.name ORDER BY d.sort_order, d.name SEPARATOR ', ')
            FROM evaluation_domains ed JOIN domains d ON d.id = ed.domain_id
           WHERE ed.evaluation_id = ev.id) AS domains
    FROM evaluations ev
    JOIN students s ON s.id = ev.student_id
    JOIN evaluators e ON e.id = ev.evaluator_id`;

type OverviewBase = Omit<EvaluationOverviewRow, "scores" | "domain_ids">;

async function attachDetails(list: OverviewBase[]): Promise<EvaluationOverviewRow[]> {
  const ids = list.map((e) => e.evaluation_id);
  const [scores, domains] = await Promise.all([
    rowsIn<{ evaluation_id: string; criterion_id: string; score: number }>(pool(), ids, (ph) => `SELECT evaluation_id, criterion_id, score FROM evaluation_scores WHERE evaluation_id IN ${ph}`),
    rowsIn<{ evaluation_id: string; domain_id: string }>(pool(), ids, (ph) => `SELECT evaluation_id, domain_id FROM evaluation_domains WHERE evaluation_id IN ${ph}`),
  ]);
  const scoreMap = new Map<string, Record<string, number>>();
  for (const s of scores) (scoreMap.get(s.evaluation_id) ?? scoreMap.set(s.evaluation_id, {}).get(s.evaluation_id)!)[s.criterion_id] = s.score;
  const domainMap = new Map<string, string[]>();
  for (const d of domains) (domainMap.get(d.evaluation_id) ?? domainMap.set(d.evaluation_id, []).get(d.evaluation_id)!).push(d.domain_id);
  return list.map((e) => ({ ...e, scores: scoreMap.get(e.evaluation_id) ?? {}, domain_ids: domainMap.get(e.evaluation_id) ?? [] }));
}

export interface EvaluationFilters {
  evaluator: string;
  department: string;
  domain: string;
  q: string;
  status: "" | "IN_PROGRESS" | "COMPLETED";
  /** A verdict, or NOT_SET for evaluations without one. */
  decision: "" | Decision | "NOT_SET";
  page: number;
}

export async function listEvaluations(f: EvaluationFilters, pageSize = 50) {
  const filter = new Filter();
  if (f.evaluator) filter.add("ev.evaluator_id = ?", f.evaluator);
  if (f.department) filter.add("s.department = ?", f.department);
  if (f.domain) filter.add("EXISTS (SELECT 1 FROM evaluation_domains x WHERE x.evaluation_id = ev.id AND x.domain_id = ?)", f.domain);
  const q = f.q.trim().slice(0, 100);
  if (q) {
    const like = `%${escapeLike(q)}%`;
    filter.add("(s.register_number LIKE ? OR s.name LIKE ?)", like, like);
  }
  if (f.status) filter.add("ev.status = ?", f.status);
  if (f.decision === "NOT_SET") filter.add("ev.decision IS NULL");
  else if (f.decision) filter.add("ev.decision = ?", f.decision);
  const clause = filter.sql;
  const params = filter.params;

  const [list, count] = await Promise.all([
    rows<OverviewBase>(pool(), `${EVALUATION_OVERVIEW_SQL}${clause} ORDER BY ev.updated_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, (f.page - 1) * pageSize]),
    one<{ n: number }>(pool(), `SELECT COUNT(*) AS n FROM evaluations ev JOIN students s ON s.id = ev.student_id${clause}`, params),
  ]);
  return { rows: await attachDetails(list), total: num(count?.n) };
}

export async function getEvaluationOverviewsByIds(ids: readonly string[]) {
  return attachDetails(await rowsIn<OverviewBase>(pool(), ids, (ph) => `${EVALUATION_OVERVIEW_SQL} WHERE ev.id IN ${ph}`));
}

export async function getCompletedEvaluationsByStudentIds(studentIds: readonly string[]) {
  return attachDetails(
    await rowsIn<OverviewBase>(pool(), studentIds, (ph) => `${EVALUATION_OVERVIEW_SQL} WHERE ev.status = 'COMPLETED' AND ev.student_id IN ${ph}`),
  );
}

export async function getStudentDetail(id: string) {
  const student = await one<StudentRow>(pool(), "SELECT * FROM students WHERE id = ?", [id]);
  if (!student) return null;
  const [idea, evaluation, criteria] = await Promise.all([
    one<IdeaRow>(pool(), "SELECT * FROM ideas WHERE student_id = ?", [id]),
    rows<OverviewBase>(pool(), `${EVALUATION_OVERVIEW_SQL} WHERE ev.student_id = ?`, [id]).then(attachDetails),
    rows<CriterionRow>(pool(), "SELECT * FROM evaluation_criteria ORDER BY sort_order, name"),
  ]);
  return { student, idea, evaluation: evaluation[0] ?? null, criteria };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** All students with a COMPLETED evaluation, with per-criterion scores (input to ranking). */
export async function loadResultRows(db: Queryable = pool()): Promise<StudentResultRow[]> {
  const [list, scores] = await Promise.all([
    rows<Omit<StudentResultRow, "scores">>(
      db,
      `SELECT s.id AS student_id, s.register_number, s.name, s.department, s.section, s.status, s.tie_break_priority,
              ev.id AS evaluation_id, ev.decision, ev.total_score, ev.max_total, ev.submitted_at, e.name AS evaluator_name,
              (SELECT GROUP_CONCAT(d.name ORDER BY d.sort_order, d.name SEPARATOR ', ')
                 FROM evaluation_domains ed JOIN domains d ON d.id = ed.domain_id
                WHERE ed.evaluation_id = ev.id) AS domains
         FROM students s
         JOIN evaluations ev ON ev.student_id = s.id AND ev.status = 'COMPLETED'
         JOIN evaluators e ON e.id = ev.evaluator_id
        ORDER BY s.register_number`,
    ),
    rows<{ evaluation_id: string; criterion_id: string; score: number }>(
      db,
      `SELECT sc.evaluation_id, sc.criterion_id, sc.score
         FROM evaluation_scores sc JOIN evaluations ev ON ev.id = sc.evaluation_id WHERE ev.status = 'COMPLETED'`,
    ),
  ]);
  const byEvaluation = new Map<string, Record<string, number>>();
  for (const s of scores) (byEvaluation.get(s.evaluation_id) ?? byEvaluation.set(s.evaluation_id, {}).get(s.evaluation_id)!)[s.criterion_id] = s.score;
  return list.map((r) => ({ ...r, scores: byEvaluation.get(r.evaluation_id) ?? {} }));
}

// ---------------------------------------------------------------------------
// Sync + audit
// ---------------------------------------------------------------------------

const JOB_COLUMNS = "id, entity_type, entity_id, status, attempts, last_error, next_retry_at, locked_at, created_at, processed_at";

export async function getSyncOverview() {
  const [counts, failed, recent, formRuns, lastSuccess, workerActive] = await Promise.all([
    rows<{ status: string; n: number }>(pool(), "SELECT status, COUNT(*) AS n FROM sheet_sync_queue GROUP BY status"),
    rows<SyncJobRow>(pool(), `SELECT ${JOB_COLUMNS} FROM sheet_sync_queue WHERE status = 'FAILED' ORDER BY created_at DESC LIMIT 50`),
    rows<SyncJobRow>(pool(), `SELECT ${JOB_COLUMNS} FROM sheet_sync_queue ORDER BY created_at DESC LIMIT 30`),
    rows<FormSyncRunRow>(pool(), "SELECT * FROM form_sync_runs ORDER BY created_at DESC LIMIT 15"),
    one<{ at: string | null }>(pool(), "SELECT MAX(processed_at) AS at FROM sheet_sync_queue WHERE status = 'SUCCESS'"),
    isSyncWorkerActive(),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, num(c.n)]));
  return {
    counts: {
      PENDING: byStatus.PENDING ?? 0,
      PROCESSING: byStatus.PROCESSING ?? 0,
      SUCCESS: byStatus.SUCCESS ?? 0,
      FAILED: byStatus.FAILED ?? 0,
      SUPERSEDED: byStatus.SUPERSEDED ?? 0,
    },
    failed,
    recent,
    formRuns,
    lastSuccessAt: lastSuccess?.at ?? null,
    workerActive,
  };
}

export async function listAuditLogs(f: { action: string; page: number }, pageSize = 50) {
  const clause = f.action ? " WHERE a.action = ?" : "";
  const params = f.action ? [f.action] : [];
  const [list, count] = await Promise.all([
    rows<AuditLogWithUser>(
      pool(),
      `SELECT a.id, a.user_id, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at,
              u.full_name AS user_name, u.email AS user_email, u.role AS user_role
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id${clause}
        ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (f.page - 1) * pageSize],
    ),
    one<{ n: number }>(pool(), `SELECT COUNT(*) AS n FROM audit_logs a${clause}`, params),
  ]);
  return { rows: list, total: num(count?.n) };
}
