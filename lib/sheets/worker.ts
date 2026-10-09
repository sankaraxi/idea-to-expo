import "server-only";
import { randomUUID } from "node:crypto";
import { pool, rowsIn } from "@/lib/db/sql";
import { googleConfig } from "@/lib/env";
import { resolveMapping } from "@/lib/forms/mapping";
import { rankStudents } from "@/lib/results/ranking";
import { audit } from "@/lib/services/audit";
import { listCriteria } from "@/lib/services/criteria";
import { listEvaluatorProgress } from "@/lib/services/evaluators";
import {
  getCompletedEvaluationsByStudentIds,
  getDashboardStats,
  getEvaluationOverviewsByIds,
  getStudentOverviewsByIds,
  loadResultRows,
} from "@/lib/services/reports";
import { getSettingsRow } from "@/lib/services/settings";
import {
  acquireSyncLock,
  claimSyncJobs,
  completeSyncJobs,
  failSyncJobs,
  releaseSyncLock,
} from "@/lib/services/sync-queue";
import type { SyncEntityType, SyncJobRow } from "@/types/database";
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
export async function processSyncQueue(options: { timeBudgetMs?: number; targets?: SyncTargets } = {}): Promise<SyncRunReport> {
  const targets = options.targets ?? createSyncTargets();
  const report: SyncRunReport = { status: "idle", processed: 0, failed: 0, batches: 0, errors: [] };
  if (!targets.reporting && !targets.responses) return { ...report, status: "disabled" };

  const holder = randomUUID();
  const deadline = Date.now() + (options.timeBudgetMs ?? 45_000);

  if (!(await acquireSyncLock(LOCK_NAME, holder, LOCK_TTL_SECONDS))) return { ...report, status: "locked" };

  try {
    let tabsReady = false;
    while (Date.now() < deadline) {
      const jobs = await claimSyncJobs(BATCH_SIZE);
      if (jobs.length === 0) break;
      report.batches++;

      for (const [type, group] of groupByType(jobs)) {
        try {
          if (type === "RESPONSE_ROW") {
            if (targets.responses) await writeResponseRows(targets.responses, group);
          } else if (targets.reporting) {
            if (!tabsReady) {
              await ensureTabs(targets.reporting, ALL_TABS);
              tabsReady = true;
            }
            await syncReportingType(targets.reporting, type, group);
          }
          await completeSyncJobs(group.map((j) => j.id));
          report.processed += group.length;
        } catch (e) {
          await failSyncJobs(group.map((j) => j.id), message(e), MAX_ATTEMPTS);
          report.failed += group.length;
          report.errors.push(`${type}: ${message(e)}`);
        }
      }
      await acquireSyncLock(LOCK_NAME, holder, LOCK_TTL_SECONDS); // renew the lease
    }
  } catch (e) {
    report.errors.push(message(e));
    report.status = "error";
  } finally {
    await releaseSyncLock(LOCK_NAME, holder);
  }

  if (report.failed > 0) {
    await audit("GOOGLE_SHEET_SYNC_FAILURE", {
      entityType: "sheet_sync_queue",
      metadata: { failed: report.failed, errors: report.errors.slice(0, 5) },
    });
  }
  if (report.status !== "error") report.status = report.batches > 0 ? "processed" : "idle";
  return report;
}

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
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

async function syncReportingType(api: SheetsApi, type: SyncEntityType, jobs: SyncJobRow[]) {
  const ids = unique(jobs.map((j) => j.entity_id));
  switch (type) {
    case "STUDENT": {
      await upsertKeyedRows(api, TABS.STUDENT, (await getStudentOverviewsByIds(ids)).map(studentRecord));
      return;
    }
    case "EVALUATOR": {
      await upsertKeyedRows(api, TABS.EVALUATOR, (await listEvaluatorProgress(ids)).map(evaluatorRecord));
      return;
    }
    case "EVALUATION": {
      const [found, criteria] = await Promise.all([getEvaluationOverviewsByIds(ids), listCriteria()]);
      const seen = new Set(found.map((r) => r.evaluation_id));
      await upsertKeyedRows(api, TABS.EVALUATION, [
        ...found.map((r) => evaluationRecord(r, criteria)),
        ...ids.filter((id) => !seen.has(id)).map(releasedEvaluationRecord), // evaluation was released/deleted
      ]);
      return;
    }
    case "RESULTS": {
      await replaceTable(api, TABS.RESULTS, resultRows(await loadRankedResults()));
      await replaceTable(api, TABS.DASHBOARD, dashboardRows(await getDashboardStats()));
      return;
    }
    default:
      return;
  }
}

/** Writes criterion scores / total (and optional evaluator, domains) into the response sheet. */
async function writeResponseRows(target: NonNullable<SyncTargets["responses"]>, jobs: SyncJobRow[]) {
  const tab = `'${target.tab.replace(/'/g, "''")}'`;
  const [settings, criteria, headerValues] = await Promise.all([getSettingsRow(), listCriteria(), target.api.getValues(`${tab}!1:1`)]);

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
    rowsIn<{ id: string; register_number: string; email: string | null }>(pool(), studentIds, (ph) => `SELECT id, register_number, email FROM students WHERE id IN ${ph}`),
    getCompletedEvaluationsByStudentIds(studentIds),
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

export async function loadRankedResults() {
  const [settings, rows] = await Promise.all([getSettingsRow(), loadResultRows()]);
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
        decision: r.decision,
      })),
    settings.tie_breakers,
  );
}

