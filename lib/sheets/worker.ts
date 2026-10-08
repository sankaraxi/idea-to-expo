import "server-only";
import { randomUUID } from "node:crypto";
import { googleConfig } from "@/lib/env";
import { resolveMapping } from "@/lib/forms/mapping";
import { rankStudents } from "@/lib/results/ranking";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import { fetchAllPages } from "@/lib/supabase/paginate";
import type { DashboardStats, SyncEntityType, SyncJobRow } from "@/types/database";
import { GoogleSheetsApi, type SheetsApi } from "./api";
import { columnLetter, ensureTabs, replaceTable, upsertKeyedRows } from "./engine";
import {
  ALL_TABS,
  TABS,
  dashboardRows,
  evaluationRecord,
  evaluatorRecord,
  releasedEvaluationRecord,
  resultRows,
  studentRecord,
} from "./tabs";
import { buildRowUpdates, findResponseRow, resolveLayout, resolveWritebackSettings } from "./writeback";

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

/** Both targets are optional; a job whose target is not configured is completed as a no-op. */
export interface SyncTargets {
  /** Reporting spreadsheet (GOOGLE_SHEET_ID). */
  reporting: SheetsApi | null;
  /** Problem statement response spreadsheet (score write-back). */
  responses: { api: SheetsApi; tab: string } | null;
}

export function sheetsConfigured() {
  const config = googleConfig();
  return !!config && (!!config.sheetId || !!config.formResponseSheetId);
}

export function createSyncTargets(): SyncTargets {
  const config = googleConfig();
  if (!config) return { reporting: null, responses: null };
  return {
    reporting: config.sheetId ? new GoogleSheetsApi(config, config.sheetId) : null,
    responses: config.formResponseSheetId
      ? { api: new GoogleSheetsApi(config, config.formResponseSheetId), tab: config.formResponseRange }
      : null,
  };
}

/**
 * Drains the sync queue into Google Sheets. Safe to call concurrently from
 * after() hooks, cron and the admin page: only the lease holder works.
 */
export async function processSyncQueue(
  options: { timeBudgetMs?: number; targets?: SyncTargets; db?: AdminClient } = {},
): Promise<SyncRunReport> {
  const targets = options.targets ?? createSyncTargets();
  const report: SyncRunReport = { status: "idle", processed: 0, failed: 0, batches: 0, errors: [] };
  if (!targets.reporting && !targets.responses) return { ...report, status: "disabled" };

  const db = options.db ?? createAdminClient();
  const holder = randomUUID();
  const deadline = Date.now() + (options.timeBudgetMs ?? 45_000);

  const lock = await db.rpc("acquire_sync_lock", { p_name: LOCK_NAME, p_holder: holder, p_ttl_seconds: LOCK_TTL_SECONDS });
  if (lock.error) return { ...report, status: "error", errors: [lock.error.message] };
  if (!lock.data) return { ...report, status: "locked" };

  try {
    let tabsReady = false;
    while (Date.now() < deadline) {
      const { data: jobs, error } = await db.rpc("claim_sync_jobs", { p_limit: BATCH_SIZE });
      if (error) throw new Error(`claim_sync_jobs: ${error.message}`);
      if (!jobs || jobs.length === 0) break;
      report.batches++;

      for (const [type, group] of groupByType(jobs)) {
        try {
          if (type === "RESPONSE_ROW") {
            if (targets.responses) await writeResponseRows(db, targets.responses, group);
          } else if (targets.reporting) {
            if (!tabsReady) {
              await ensureTabs(targets.reporting, ALL_TABS);
              tabsReady = true;
            }
            await syncReportingType(db, targets.reporting, type, group);
          }
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
  const order: SyncEntityType[] = ["STUDENT", "EVALUATOR", "EVALUATION", "RESPONSE_ROW", "RESULTS"];
  const map = new Map<SyncEntityType, SyncJobRow[]>();
  for (const type of order) {
    const group = jobs.filter((j) => j.entity_type === type);
    if (group.length) map.set(type, group);
  }
  return map;
}

const unique = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((v): v is string => !!v))];

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

async function loadCriteria(db: AdminClient) {
  const { data, error } = await db
    .from("evaluation_criteria")
    .select("id, name, max_marks, sheet_column, is_active, sort_order")
    .order("sort_order")
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function syncReportingType(db: AdminClient, api: SheetsApi, type: SyncEntityType, jobs: SyncJobRow[]) {
  const ids = unique(jobs.map((j) => j.entity_id));
  switch (type) {
    case "STUDENT": {
      const rows = await fetchIn(ids, (c) => db.from("student_overview").select("*").in("id", c));
      await upsertKeyedRows(api, TABS.STUDENT, rows.map(studentRecord));
      return;
    }
    case "EVALUATOR": {
      const rows = await fetchIn(ids, (c) => db.from("evaluator_progress").select("*").in("evaluator_id", c));
      await upsertKeyedRows(api, TABS.EVALUATOR, rows.map(evaluatorRecord));
      return;
    }
    case "EVALUATION": {
      const [rows, criteria] = await Promise.all([
        fetchIn(ids, (c) => db.from("evaluation_overview").select("*").in("evaluation_id", c)),
        loadCriteria(db),
      ]);
      const found = new Set(rows.map((r) => r.evaluation_id));
      await upsertKeyedRows(api, TABS.EVALUATION, [
        ...rows.map((r) => evaluationRecord(r, criteria)),
        ...ids.filter((id) => !found.has(id)).map(releasedEvaluationRecord),
      ]);
      return;
    }
    case "RESULTS": {
      await replaceTable(api, TABS.RESULTS, resultRows(await loadRankedResults(db)));
      const { data: stats, error } = await db.rpc("dashboard_stats");
      if (error) throw new Error(error.message);
      await replaceTable(api, TABS.DASHBOARD, dashboardRows(stats as unknown as DashboardStats));
      return;
    }
    default:
      return;
  }
}

/** Writes criterion scores / total (and optional evaluator, domains) into the response sheet. */
async function writeResponseRows(db: AdminClient, target: NonNullable<SyncTargets["responses"]>, jobs: SyncJobRow[]) {
  const tab = `'${target.tab.replace(/'/g, "''")}'`;
  const [{ data: settings, error: settingsError }, criteria, headerValues] = await Promise.all([
    db.from("app_settings").select("form_field_mapping, sheet_writeback").single(),
    loadCriteria(db),
    target.api.getValues(`${tab}!1:1`),
  ]);
  if (settingsError) throw new Error(settingsError.message);

  const headers = (headerValues[0] ?? []).map((h) => String(h ?? ""));
  const layout = resolveLayout(headers, resolveMapping(settings.form_field_mapping), criteria, resolveWritebackSettings(settings.sheet_writeback));
  if (layout.registerCol === null && layout.emailCol === null) {
    throw new Error("Response sheet has no register number or email column (check Settings → field mapping).");
  }
  if (layout.criterionCols.size === 0 && layout.totalCol === null) {
    throw new Error(`No score columns found in the response sheet: ${layout.missing.join("; ")}`);
  }

  const column = async (index: number | null) => {
    if (index === null) return [];
    const col = columnLetter(index);
    return (await target.api.getValues(`${tab}!${col}2:${col}`)).map((r) => r[0] ?? null);
  };
  const [registerColumn, emailColumn] = await Promise.all([column(layout.registerCol), column(layout.emailCol)]);

  const studentIds = unique(jobs.map((j) => j.entity_id));
  const [students, evaluations] = await Promise.all([
    fetchIn(studentIds, (c) => db.from("students").select("id, register_number, email").in("id", c)),
    fetchIn(studentIds, (c) => db.from("evaluation_overview").select("*").in("student_id", c).eq("status", "COMPLETED")),
  ]);
  const evalByStudent = new Map(evaluations.map((e) => [e.student_id, e]));

  const updates = students.flatMap((s) => {
    const row = findResponseRow(registerColumn, emailColumn, s);
    if (row === null) return []; // imported student without a form response: nothing to write
    const ev = evalByStudent.get(s.id);
    return buildRowUpdates(
      target.tab,
      row,
      layout,
      ev ? { scores: ev.scores, total: ev.total_score ?? 0, evaluatorName: ev.evaluator_name, domains: ev.domains ?? "" } : null,
    );
  });
  for (let i = 0; i < updates.length; i += 500) await target.api.batchUpdate(updates.slice(i, i + 500));
}

export async function loadRankedResults(db: AdminClient) {
  const [{ data: settings, error }, rows] = await Promise.all([
    db.from("app_settings").select("tie_breakers").single(),
    fetchAllPages((from, to) => db.from("student_results").select("*").order("register_number").range(from, to)),
  ]);
  if (error) throw new Error(error.message);
  return rankStudents(
    rows
      .filter((r) => r.status === "ACTIVE")
      .map((r) => ({
        studentId: r.student_id,
        registerNumber: r.register_number,
        name: r.name,
        department: r.department,
        total: r.total_score,
        maxTotal: r.max_total,
        criterionScores: r.scores ?? {},
        tieBreakPriority: r.tie_break_priority,
        domains: r.domains,
        evaluatorName: r.evaluator_name,
      })),
    settings.tie_breakers,
  );
}
