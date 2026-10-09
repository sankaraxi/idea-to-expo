import "server-only";
import { requireAdminPage } from "@/lib/auth/session";
import * as criteria from "@/lib/services/criteria";
import { listEvaluatorOptions as evaluatorOptions, listEvaluatorProgress } from "@/lib/services/evaluators";
import * as reports from "@/lib/services/reports";
import { getSettingsRow } from "@/lib/services/settings";
import { loadRankedResults } from "@/lib/sheets/worker";

export type { EvaluationFilters, StudentFilters } from "@/lib/services/reports";

/**
 * Admin read models. Every function authorises first: layouts and pages render
 * in parallel, so a layout-level check alone would not stop a page's query.
 */
async function admin<T>(fn: () => Promise<T>): Promise<T> {
  await requireAdminPage();
  return fn();
}

export const getDashboardStats = () => admin(() => reports.getDashboardStats());
export const getEvaluatorProgress = () => admin(() => listEvaluatorProgress());
export const getEvaluatorOptions = () => admin(() => evaluatorOptions());
export const getDepartments = () => admin(() => reports.listDepartments());
export const getCriteria = () => admin(() => criteria.listCriteria());
export const getDomains = () => admin(() => criteria.listDomains());
export const getCriteriaUsage = () => admin(() => criteria.getUsageCounts());
export const listStudents = (f: reports.StudentFilters, pageSize = 50) => admin(() => reports.listStudents(f, pageSize));
export const getStudentDetail = (id: string) => admin(() => reports.getStudentDetail(id));
export const listEvaluations = (f: reports.EvaluationFilters, pageSize = 50) => admin(() => reports.listEvaluations(f, pageSize));
export const getSyncOverview = () => admin(() => reports.getSyncOverview());
export const listAuditLogs = (f: { action: string; page: number }, pageSize = 50) => admin(() => reports.listAuditLogs(f, pageSize));
export const getFullSettings = () => admin(() => getSettingsRow());

export async function getResults() {
  return admin(async () => {
    const [ranked, settings, list] = await Promise.all([loadRankedResults(), getSettingsRow(), criteria.listCriteria()]);
    return {
      ranked,
      tieBreakers: settings.tie_breakers,
      criteria: list.map((c) => ({ id: c.id, name: c.name, max_marks: c.max_marks, is_active: c.is_active, sort_order: c.sort_order })),
    };
  });
}
