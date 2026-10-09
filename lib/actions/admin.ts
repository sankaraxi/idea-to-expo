"use server";

import Papa from "papaparse";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/session";
import { run, withTransaction } from "@/lib/db/sql";
import { AppError, fail, ok, toFailure, type ActionResult } from "@/lib/errors";
import { formFieldMappingSchema } from "@/lib/forms/mapping";
import { importStudentRows, pullFormResponses, type IngestResult } from "@/lib/forms/service";
import { writeAudit } from "@/lib/services/audit";
import * as criteria from "@/lib/services/criteria";
import * as evaluators from "@/lib/services/evaluators";
import * as evaluations from "@/lib/services/evaluations";
import * as settings from "@/lib/services/settings";
import { enqueueFullResync, enqueueSync, retryFailedSyncJobs, RESULTS_KEY } from "@/lib/services/sync-queue";
import { scheduleSheetSync } from "@/lib/sheets/trigger";
import { processSyncQueue, type SyncRunReport } from "@/lib/sheets/worker";
import { writebackSettingsSchema } from "@/lib/sheets/writeback";
import {
  createEvaluatorSchema,
  criterionSchema,
  domainSchema,
  eventStatusSchema,
  settingsSchema,
  updateEvaluatorSchema,
  uuidSchema,
} from "@/lib/validation/schemas";
import type { Json } from "@/types/database";

function invalid(error: z.ZodError) {
  return fail("VALIDATION", error.issues[0]?.message, error.flatten().fieldErrors as Record<string, string[]>);
}

// ---------------------------------------------------------------------------
// Event control
// ---------------------------------------------------------------------------

export async function setEventStatus(status: string): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = eventStatusSchema.safeParse(status);
    if (!parsed.success) return invalid(parsed.error);
    await settings.setEventStatus(admin.id, parsed.data);
    scheduleSheetSync();
    revalidatePath("/", "layout");
    return ok();
  } catch (error) {
    return toFailure(error, "setEventStatus");
  }
}

// ---------------------------------------------------------------------------
// Evaluation criteria & domains
// ---------------------------------------------------------------------------

export async function saveCriterion(input: unknown): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = criterionSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const c = parsed.data;
    await criteria.saveCriterion(admin.id, {
      id: c.id,
      name: c.name,
      description: c.description,
      maxMarks: c.maxMarks,
      inputStyle: c.inputStyle,
      sortOrder: c.sortOrder,
      isActive: c.isActive,
      sheetColumn: c.sheetColumn,
    });
    scheduleSheetSync();
    revalidatePath("/admin", "layout");
    revalidatePath("/evaluator", "layout");
    return ok();
  } catch (error) {
    return toFailure(error, "saveCriterion");
  }
}

export async function deleteCriterion(id: string): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    if (!uuidSchema.safeParse(id).success) return fail("VALIDATION");
    await criteria.deleteCriterion(admin.id, id);
    revalidatePath("/admin", "layout");
    return ok();
  } catch (error) {
    return toFailure(error, "deleteCriterion");
  }
}

export async function saveDomain(input: unknown): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = domainSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    await criteria.saveDomain(admin.id, parsed.data);
    revalidatePath("/admin", "layout");
    revalidatePath("/evaluator", "layout");
    return ok();
  } catch (error) {
    return toFailure(error, "saveDomain");
  }
}

export async function deleteDomain(id: string): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    if (!uuidSchema.safeParse(id).success) return fail("VALIDATION");
    await criteria.deleteDomain(admin.id, id);
    revalidatePath("/admin", "layout");
    return ok();
  } catch (error) {
    return toFailure(error, "deleteDomain");
  }
}

// ---------------------------------------------------------------------------
// Evaluators
// ---------------------------------------------------------------------------

export async function createEvaluator(input: unknown): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = createEvaluatorSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    await evaluators.createEvaluator(admin.id, parsed.data);
    scheduleSheetSync();
    revalidatePath("/admin/evaluators");
    return ok();
  } catch (error) {
    return toFailure(error, "createEvaluator");
  }
}

export async function updateEvaluator(input: unknown): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = updateEvaluatorSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const { id, ...rest } = parsed.data;
    await evaluators.updateEvaluator(admin.id, id, rest);
    scheduleSheetSync();
    revalidatePath("/admin/evaluators");
    return ok();
  } catch (error) {
    return toFailure(error, "updateEvaluator");
  }
}

export async function setEvaluatorActive(id: string, active: boolean): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsedId = uuidSchema.safeParse(id);
    if (!parsedId.success) return invalid(parsedId.error);
    await evaluators.setEvaluatorActive(admin.id, parsedId.data, active);
    scheduleSheetSync();
    revalidatePath("/admin/evaluators");
    return ok();
  } catch (error) {
    return toFailure(error, "setEvaluatorActive");
  }
}

export async function resetEvaluatorPassword(id: string, password: string): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = z.object({ id: uuidSchema, password: z.string().min(8).max(72) }).safeParse({ id, password });
    if (!parsed.success) return fail("VALIDATION", "Password must be at least 8 characters.");
    await evaluators.resetEvaluatorPassword(admin.id, parsed.data.id, parsed.data.password);
    return ok();
  } catch (error) {
    return toFailure(error, "resetEvaluatorPassword");
  }
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

export async function setStudentStatus(id: string, status: string): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = z.object({ id: uuidSchema, status: z.enum(["ACTIVE", "WITHDRAWN", "DISQUALIFIED"]) }).safeParse({ id, status });
    if (!parsed.success) return invalid(parsed.error);
    await withTransaction(async (tx) => {
      await run(tx, "UPDATE students SET status = ? WHERE id = ?", [parsed.data.status, parsed.data.id]);
      await writeAudit(tx, { userId: admin.id, action: "STUDENT_STATUS_CHANGED", entityType: "student", entityId: id, metadata: { status } });
      await enqueueSync(tx, "STUDENT", id);
      await enqueueSync(tx, "RESULTS", RESULTS_KEY);
    });
    scheduleSheetSync();
    revalidatePath("/admin/students");
    return ok();
  } catch (error) {
    return toFailure(error, "setStudentStatus");
  }
}

export async function setTieBreakPriority(id: string, priority: number | null): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = z.object({ id: uuidSchema, priority: z.number().int().min(1).max(100000).nullable() }).safeParse({ id, priority });
    if (!parsed.success) return invalid(parsed.error);
    await withTransaction(async (tx) => {
      await run(tx, "UPDATE students SET tie_break_priority = ? WHERE id = ?", [parsed.data.priority, parsed.data.id]);
      await writeAudit(tx, { userId: admin.id, action: "TIE_BREAK_PRIORITY_SET", entityType: "student", entityId: id, metadata: { priority } });
      await enqueueSync(tx, "RESULTS", RESULTS_KEY);
    });
    scheduleSheetSync();
    revalidatePath("/admin/results");
    return ok();
  } catch (error) {
    return toFailure(error, "setTieBreakPriority");
  }
}

/** CSV columns: name, register number, gender, department, email, phone number. */
export async function importStudentsCsv(formData: FormData): Promise<ActionResult<IngestResult>> {
  try {
    const admin = await requireAdmin();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return fail("VALIDATION", "Choose a CSV file.");
    if (file.size > 5 * 1024 * 1024) return fail("VALIDATION", "CSV must be under 5 MB.");

    const parsed = Papa.parse<string[]>(await file.text(), { skipEmptyLines: "greedy" });
    const [headers = [], ...rows] = parsed.data;
    if (headers.length === 0 || rows.length === 0) return fail("VALIDATION", "The CSV has no data rows.");
    if (rows.length > 5000) return fail("VALIDATION", "Import at most 5000 rows at a time.");

    const result = await importStudentRows(headers.map((h) => h.replace(/^﻿/, "")), rows, admin.id);
    scheduleSheetSync();
    revalidatePath("/admin", "layout");
    return ok(result);
  } catch (error) {
    return toFailure(error, "importStudentsCsv");
  }
}

export async function syncGoogleForm(): Promise<ActionResult<IngestResult>> {
  try {
    const admin = await requireAdmin();
    const result = await pullFormResponses(admin.id);
    scheduleSheetSync();
    revalidatePath("/admin", "layout");
    return ok(result);
  } catch (error) {
    if (error instanceof AppError) return toFailure(error, "syncGoogleForm");
    console.error("[syncGoogleForm]", error);
    const message =
      error instanceof Error && error.message.includes("not configured")
        ? "Problem statement sheet is not configured (GOOGLE_FORM_RESPONSE_SHEET_ID)."
        : error instanceof Error && /Sheets API 404/.test(error.message)
          ? "Spreadsheet not found. GOOGLE_FORM_RESPONSE_SHEET_ID must be the long ID between /d/ and /edit in the sheet's URL (not the gid)."
          : error instanceof Error && /Sheets API 403/.test(error.message)
            ? "Access denied. Share the spreadsheet with the service account email as Editor."
            : error instanceof Error && /Sheets API 400/.test(error.message)
              ? "Could not read the sheet tab. Check GOOGLE_FORM_RESPONSE_RANGE matches the tab name exactly."
              : "Could not read the problem statement sheet. Check the sheet ID, tab name and sharing.";
    return fail("UNKNOWN", message);
  }
}

// ---------------------------------------------------------------------------
// Google Sheets sync
// ---------------------------------------------------------------------------

export async function runSheetSyncNow(): Promise<ActionResult<SyncRunReport>> {
  try {
    await requireAdmin();
    const report = await processSyncQueue({ timeBudgetMs: 40_000 });
    revalidatePath("/admin/sync");
    return ok(report);
  } catch (error) {
    return toFailure(error, "runSheetSyncNow");
  }
}

export async function retryFailedSync(): Promise<ActionResult<{ count: number }>> {
  try {
    await requireAdmin();
    const count = await retryFailedSyncJobs();
    scheduleSheetSync();
    revalidatePath("/admin/sync");
    return ok({ count });
  } catch (error) {
    return toFailure(error, "retryFailedSync");
  }
}

export async function fullResync(): Promise<ActionResult<{ count: number }>> {
  try {
    const admin = await requireAdmin();
    const count = await enqueueFullResync(admin.id);
    scheduleSheetSync();
    revalidatePath("/admin/sync");
    return ok({ count });
  } catch (error) {
    return toFailure(error, "fullResync");
  }
}

// ---------------------------------------------------------------------------
// Evaluations (admin)
// ---------------------------------------------------------------------------

const reasonInput = z.object({ id: uuidSchema, reason: z.string().trim().min(3, "Give a reason").max(500) });

export async function reopenEvaluation(evaluationId: string, reason: string): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = reasonInput.safeParse({ id: evaluationId, reason });
    if (!parsed.success) return invalid(parsed.error);
    await evaluations.adminReopenEvaluation(admin.id, parsed.data.id, parsed.data.reason);
    scheduleSheetSync();
    revalidatePath("/admin", "layout");
    return ok();
  } catch (error) {
    return toFailure(error, "reopenEvaluation");
  }
}

/** Frees the student for another evaluator (scores kept in the audit log). */
export async function releaseEvaluation(evaluationId: string, reason: string): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = reasonInput.safeParse({ id: evaluationId, reason });
    if (!parsed.success) return invalid(parsed.error);
    await evaluations.adminReleaseEvaluation(admin.id, parsed.data.id, parsed.data.reason);
    scheduleSheetSync();
    revalidatePath("/admin", "layout");
    return ok();
  } catch (error) {
    return toFailure(error, "releaseEvaluation");
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function saveSettings(input: unknown): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    await settings.saveEvaluationSettings(admin.id, parsed.data);
    scheduleSheetSync();
    revalidatePath("/", "layout");
    return ok();
  } catch (error) {
    return toFailure(error, "saveSettings");
  }
}

export async function saveFormMapping(input: unknown): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = formFieldMappingSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    await settings.saveFormMapping(admin.id, parsed.data as unknown as Json);
    revalidatePath("/admin/settings");
    return ok();
  } catch (error) {
    return toFailure(error, "saveFormMapping");
  }
}

/** Response-sheet columns for total / evaluator / domains, plus each criterion's column header. */
export async function saveSheetWriteback(input: unknown): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = writebackSettingsSchema
      .extend({ criteria: z.array(z.object({ id: uuidSchema, sheetColumn: z.string().trim().max(200) })).max(50) })
      .safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    await settings.saveSheetWriteback(admin.id, parsed.data);
    scheduleSheetSync();
    revalidatePath("/admin/settings");
    return ok();
  } catch (error) {
    return toFailure(error, "saveSheetWriteback");
  }
}

