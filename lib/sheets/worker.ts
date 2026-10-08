import "server-only";
import { randomUUID } from "node:crypto";
import { googleConfig } from "@/lib/env";
import { rankStudents } from "@/lib/results/ranking";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import type { DashboardStats, SyncEntityType, SyncJobRow } from "@/types/database";
import { GoogleSheetsApi, type SheetsApi } from "./api";
import { ensureTabs, replaceTable, upsertKeyedRows, type KeyedRecord } from "./engine";
import {
  ALL_TABS,
  TABS,
  assignmentRecord,
  dashboardRows,
  evaluationRecord,
  evaluatorRecord,
  resultRows,
  studentRecord,
} from "./tabs";

const LOCK_NAME = "google_sheets";
const LOCK_TTL_SECONDS = 120;
const BATCH_SIZE = 500;
const MAX_ATTEMPTS = 10;

export interface SyncRunReport {
  status: "disabled" | "locked" | "idle" | "processed" | "error";
  processed: number;
  failed: number;
  batches: number;
  errors: string[];
}

export function sheetsConfigured() {
  return googleConfig() !== null;
}

export function createSheetsApi(): SheetsApi | null {
  const config = googleConfig();
  return config ? new GoogleSheetsApi(config, config.sheetId) : null;
}

/**
 * Drains the sync queue into the live spreadsheet. Safe to call from many
 * places at once (after() hooks, cron, admin button): only the lease holder
 * works, everyone else returns "locked" immediately.
 */
export async function processSyncQueue(
  options: { timeBudgetMs?: number; api?: SheetsApi | null; db?: AdminClient } = {},
): Promise<SyncRunReport> {
  const api = options.api === undefined ? createSheetsApi() : options.api;
  const report: SyncRunReport = { status: "idle", processed: 0, failed: 0, batches: 0, errors: [] };
  if (!api) return { ...report, status: "disabled" };

  const db = options.db ?? createAdminClient();
  const holder = randomUUID();
  const deadline = Date.now() + (options.timeBudgetMs ?? 45_000);

  const lock = await db.rpc("acquire_sync_lock", {
    p_name: LOCK_NAME,
    p_holder: holder,
    p_ttl_seconds: LOCK_TTL_SECONDS,
  });
  if (lock.error) return { ...report, status: "error", errors: [lock.error.message] };
  if (!lock.data) return { ...report, status: "locked" };

  try {
    let tabsReady = false;
    while (Date.now() < deadline) {
      const { data: jobs, error } = await db.rpc("claim_sync_jobs", { p_limit: BATCH_SIZE });
      if (error) throw new Error(`claim_sync_jobs: ${error.message}`);
      if (!jobs || jobs.length === 0) break;

      if (!tabsReady) {
        try {
          await ensureTabs(api, ALL_TABS);
          tabsReady = true;
        } catch (e) {
          await failJobs(db, jobs, e);
          report.failed += jobs.length;
          report.errors.push(message(e));
          break;
        }
      }

      report.batches++;
      const byType = groupByType(jobs);
      for (const [type, group] of byType) {
        try {
          await syncEntityType(db, api, type, group);
          const { error: doneError } = await db.rpc("complete_sync_jobs", { p_ids: group.map((j) => j.id) });
          if (doneError) throw new Error(doneError.message);
          report.processed += group.length;
        } catch (e) {
          await failJobs(db, group, e);
          report.failed += group.length;
          report.errors.push(`${type}: ${message(e)}`);
        }
      }

      await db.rpc("acquire_sync_lock", { p_name: LOCK_NAME, p_holder: holder, p_ttl_seconds: LOCK_TTL_SECONDS });
    }
  } catch (e) {
    report.errors.push(message(e));
    report.status = "error";
  } finally {
    await db.rpc("release_sync_lock", { p_name: LOCK_NAME, p_holder: holder });
  }

  if (report.failed > 0) {
    await db.from("audit_logs").insert({
      action: "GOOGLE_SHEET_SYNC_FAILURE",
      entity_type: "sheet_sync_queue",
      metadata: { failed: report.failed, errors: report.errors.slice(0, 5) },
    });
  }
  if (report.status !== "error") report.status = report.batches > 0 ? "processed" : "idle";
  return report;
}

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

async function failJobs(db: AdminClient, jobs: SyncJobRow[], error: unknown) {
  const { error: rpcError } = await db.rpc("fail_sync_jobs", {
    p_ids: jobs.map((j) => j.id),
    p_error: message(error),
    p_max_attempts: MAX_ATTEMPTS,
  });
  if (rpcError) console.error("[sheets] fail_sync_jobs", rpcError.message);
}

function groupByType(jobs: SyncJobRow[]) {
  // Process in dependency-friendly order so a viewer sees students before results.
  const order: SyncEntityType[] = ["STUDENT", "EVALUATOR", "ASSIGNMENT", "EVALUATION", "RESULTS"];
  const map = new Map<SyncEntityType, SyncJobRow[]>();
  for (const type of order) {
    const group = jobs.filter((j) => j.entity_type === type);
    if (group.length) map.set(type, group);
  }
  return map;
}

const unique = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((v): v is string => !!v))];

/** `.in()` with chunking to keep PostgREST URLs short. */
async function fetchIn<T>(
  ids: string[],
  query: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await query(ids.slice(i, i + 150));
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
  }
  return out;
}

async function syncEntityType(db: AdminClient, api: SheetsApi, type: SyncEntityType, jobs: SyncJobRow[]) {
  const ids = unique(jobs.map((j) => j.entity_id));

  switch (type) {
    case "STUDENT": {
      const students = await fetchIn(ids, (c) =>
        db
          .from("students")
          .select("id, register_number, name, department, section, email, created_at, updated_at")
          .in("id", c),
      );
      const ideas = await fetchIn(ids, (c) =>
        db.from("ideas").select("student_id, submission_status, ppt_url, updated_at").in("student_id", c),
      );
      const ideaByStudent = new Map(ideas.map((i) => [i.student_id, i]));
      await upsertKeyedRows(api, TABS.STUDENT, students.map((s) => studentRecord(s, ideaByStudent.get(s.id))));
      return;
    }
    case "EVALUATOR": {
      const rows = await fetchIn(ids, (c) => db.from("evaluator_progress").select("*").in("evaluator_id", c));
      await upsertKeyedRows(api, TABS.EVALUATOR, rows.map(evaluatorRecord));
      return;
    }
    case "ASSIGNMENT": {
      const assignments = await fetchIn(ids, (c) =>
        db
          .from("evaluation_assignments")
          .select("id, student_id, evaluator_id, allocation_batch_id, assigned_at, status")
          .in("id", c),
      );
      const [students, evaluators, batches] = await Promise.all([
        fetchIn(unique(assignments.map((a) => a.student_id)), (c) =>
          db.from("students").select("id, register_number, name").in("id", c),
        ),
        fetchIn(unique(assignments.map((a) => a.evaluator_id)), (c) =>
          db.from("evaluators").select("id, name, employee_id").in("id", c),
        ),
        fetchIn(unique(assignments.map((a) => a.allocation_batch_id)), (c) =>
          db.from("allocation_batches").select("id, allocation_type, created_at").in("id", c),
        ),
      ]);
      const s = new Map(students.map((x) => [x.id, x]));
      const e = new Map(evaluators.map((x) => [x.id, x]));
      const b = new Map(batches.map((x) => [x.id, x]));
      const records: KeyedRecord[] = assignments.map((a) =>
        assignmentRecord(a, s.get(a.student_id), e.get(a.evaluator_id), a.allocation_batch_id ? b.get(a.allocation_batch_id) : undefined),
      );
      await upsertKeyedRows(api, TABS.ASSIGNMENT, records);
      return;
    }
    case "EVALUATION": {
      const evaluations = await fetchIn(ids, (c) =>
        db
          .from("evaluations")
          .select("id, student_id, evaluator_id, score, remarks, status, submitted_at, updated_at")
          .in("id", c),
      );
      const [students, evaluators] = await Promise.all([
        fetchIn(unique(evaluations.map((x) => x.student_id)), (c) =>
          db.from("students").select("id, register_number, name").in("id", c),
        ),
        fetchIn(unique(evaluations.map((x) => x.evaluator_id)), (c) =>
          db.from("evaluators").select("id, name").in("id", c),
        ),
      ]);
      const s = new Map(students.map((x) => [x.id, x]));
      const e = new Map(evaluators.map((x) => [x.id, x]));
      await upsertKeyedRows(
        api,
        TABS.EVALUATION,
        evaluations.map((x) => evaluationRecord(x, s.get(x.student_id), e.get(x.evaluator_id))),
      );
      return;
    }
    case "RESULTS": {
      const ranked = await loadRankedResults(db);
      await replaceTable(api, TABS.RESULTS, resultRows(ranked));
      const { data: stats, error } = await db.rpc("dashboard_stats");
      if (error) throw new Error(error.message);
      await replaceTable(api, TABS.DASHBOARD, dashboardRows(stats as unknown as DashboardStats));
      return;
    }
  }
}

export async function loadRankedResults(db: AdminClient) {
  const [{ data: settings, error: settingsError }, rows] = await Promise.all([
    db.from("app_settings").select("tie_breakers").single(),
    fetchAllResults(db),
  ]);
  if (settingsError) throw new Error(settingsError.message);
  return rankStudents(
    rows
      .filter((r) => r.status === "ACTIVE")
      .map((r) => ({
        studentId: r.student_id,
        registerNumber: r.register_number,
        name: r.name,
        department: r.department,
        scores: r.scores ?? [],
        tieBreakPriority: r.tie_break_priority,
      })),
    { tieBreakers: settings.tie_breakers },
  ).ranked;
}

async function fetchAllResults(db: AdminClient) {
  const pageSize = 1000;
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("student_results")
      .select("*")
      .order("register_number")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}
