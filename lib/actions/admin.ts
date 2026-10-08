"use server";

import Papa from "papaparse";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth/session";
import { AppError, fail, ok, toFailure, type ActionResult } from "@/lib/errors";
import { formFieldMappingSchema } from "@/lib/forms/mapping";
import { importStudentRows, pullFormResponses, type IngestResult } from "@/lib/forms/service";
import { scheduleSheetSync } from "@/lib/sheets/trigger";
import { processSyncQueue, type SyncRunReport } from "@/lib/sheets/worker";
import { writebackSettingsSchema } from "@/lib/sheets/writeback";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";
import {
  createEvaluatorSchema,
  criterionSchema,
  domainSchema,
  eventStatusSchema,
  settingsSchema,
  updateEvaluatorSchema,
  uuidSchema,
} from "@/lib/validation/schemas";

function invalid(error: z.ZodError) {
  return fail("VALIDATION", error.issues[0]?.message, error.flatten().fieldErrors as Record<string, string[]>);
}

// ---------------------------------------------------------------------------
// Event control
// ---------------------------------------------------------------------------

export async function setEventStatus(status: string): Promise<ActionResult> {
  try {
    await requireAdmin();
    const parsed = eventStatusSchema.safeParse(status);
    if (!parsed.success) return invalid(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.rpc("set_event_status", { p_status: parsed.data });
    if (error) return toFailure(error, "setEventStatus");
    scheduleSheetSync();
    revalidatePath("/", "layout");
    return ok();
  } catch (error) {
    return toFailure(error, "setEventStatus");
  }
}

// ---------------------------------------------------------------------------
// Evaluation criteria
// ---------------------------------------------------------------------------

export async function saveCriterion(input: unknown): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = criterionSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const c = parsed.data;
    const db = createAdminClient();

    if (c.id) {
      // Never invalidate scores already given.
      const { data: top } = await db
        .from("evaluation_scores")
        .select("score")
        .eq("criterion_id", c.id)
        .order("score", { ascending: false })
        .limit(1);
      if (top?.[0] && top[0].score > c.maxMarks) {
        return fail("CRITERION_IN_USE", `Scores up to ${top[0].score} were already given for this criterion; the maximum cannot go below that.`);
      }
    }

    const row = {
      name: c.name,
      description: c.description,
      max_marks: c.maxMarks,
      input_style: c.inputStyle,
      sort_order: c.sortOrder,
      is_active: c.isActive,
      sheet_column: c.sheetColumn,
    };
    const { error } = c.id
      ? await db.from("evaluation_criteria").update(row).eq("id", c.id)
      : await db.from("evaluation_criteria").insert(row);
    if (error) return fail("VALIDATION", error.code === "23505" ? "A criterion with this name already exists." : "Could not save the criterion.");

    await audit(c.id ? "CRITERION_UPDATED" : "CRITERION_CREATED", { userId: admin.id, entityType: "criterion", entityId: c.id, metadata: row });
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
    const db = createAdminClient();
    const { count } = await db.from("evaluation_scores").select("criterion_id", { count: "exact", head: true }).eq("criterion_id", id);
    if ((count ?? 0) > 0) return fail("CRITERION_IN_USE");
    const { error } = await db.from("evaluation_criteria").delete().eq("id", id);
    if (error) return fail("CRITERION_IN_USE");
    await audit("CRITERION_DELETED", { userId: admin.id, entityType: "criterion", entityId: id });
    revalidatePath("/admin", "layout");
    return ok();
  } catch (error) {
    return toFailure(error, "deleteCriterion");
  }
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export async function saveDomain(input: unknown): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = domainSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const d = parsed.data;
    const db = createAdminClient();
    const row = { name: d.name, sort_order: d.sortOrder, is_active: d.isActive };
    const { error } = d.id ? await db.from("domains").update(row).eq("id", d.id) : await db.from("domains").insert(row);
    if (error) return fail("VALIDATION", error.code === "23505" ? "A domain with this name already exists." : "Could not save the domain.");
    await audit(d.id ? "DOMAIN_UPDATED" : "DOMAIN_CREATED", { userId: admin.id, entityType: "domain", entityId: d.id, metadata: row });
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
    const db = createAdminClient();
    const { count } = await db.from("evaluation_domains").select("domain_id", { count: "exact", head: true }).eq("domain_id", id);
    if ((count ?? 0) > 0) return fail("DOMAIN_IN_USE");
    const { error } = await db.from("domains").delete().eq("id", id);
    if (error) return fail("DOMAIN_IN_USE");
    await audit("DOMAIN_DELETED", { userId: admin.id, entityType: "domain", entityId: id });
    revalidatePath("/admin", "layout");
    return ok();
  } catch (error) {
    return toFailure(error, "deleteDomain");
  }
}

// ---------------------------------------------------------------------------
// Evaluators
// ---------------------------------------------------------------------------

const BAN_FOREVER = "876000h";

export async function createEvaluator(input: unknown): Promise<ActionResult> {
  try {
    const admin = await requireAdmin();
    const parsed = createEvaluatorSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const v = parsed.data;
    const db = createAdminClient();

    const { data: created, error: authError } = await db.auth.admin.createUser({
      email: v.email,
      password: v.password,
      email_confirm: true,
      user_metadata: { name: v.name },
    });
    if (authError || !created.user) {
      return fail("VALIDATION", authError?.message.includes("already") ? "A user with this email already exists." : "Could not create the login.");
    }
    const userId = created.user.id;

    const { error: profileError } = await db.from("profiles").insert({ id: userId, role: "EVALUATOR", full_name: v.name, email: v.email });
    const { data: evaluator, error: evaluatorError } = profileError
      ? { data: null, error: profileError }
      : await db
          .from("evaluators")
          .insert({
            user_id: userId,
            name: v.name,
            email: v.email,
            employee_id: v.employeeId,
            department: v.department,
            max_evaluations: v.maxEvaluations,
          })
          .select("id")
          .single();

    if (profileError || evaluatorError || !evaluator) {
      await db.auth.admin.deleteUser(userId); // roll back the orphan login
      const duplicate = (profileError ?? evaluatorError)?.code === "23505";
      return fail("VALIDATION", duplicate ? "Email or employee ID already in use." : "Could not create the evaluator.");
    }

    await audit("EVALUATOR_CREATED", { userId: admin.id, entityType: "evaluator", entityId: evaluator.id, metadata: { email: v.email } });
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
    const v = parsed.data;
    const db = createAdminClient();
    const { data: existing } = await db.from("evaluators").select("user_id, email").eq("id", v.id).single();
    if (!existing) return fail("VALIDATION", "Evaluator not found.");

    if (existing.user_id && existing.email !== v.email) {
      const { error } = await db.auth.admin.updateUserById(existing.user_id, { email: v.email, email_confirm: true });
      if (error) return fail("VALIDATION", "Could not change the login email (is it already used?).");
    }
    const { error } = await db
      .from("evaluators")
      .update({ name: v.name, email: v.email, employee_id: v.employeeId, department: v.department, max_evaluations: v.maxEvaluations })
      .eq("id", v.id);
    if (error) return fail("VALIDATION", error.code === "23505" ? "Email or employee ID already in use." : "Could not save changes.");
    if (existing.user_id) await db.from("profiles").update({ full_name: v.name, email: v.email }).eq("id", existing.user_id);

    await audit("EVALUATOR_UPDATED", { userId: admin.id, entityType: "evaluator", entityId: v.id });
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
    const db = createAdminClient();
    const { data: evaluator, error } = await db
      .from("evaluators")
      .update({ status: active ? "ACTIVE" : "DISABLED" })
      .eq("id", parsedId.data)
      .select("user_id")
      .single();
    if (error || !evaluator) return fail("VALIDATION", "Evaluator not found.");
    if (evaluator.user_id) {
      await db.auth.admin.updateUserById(evaluator.user_id, { ban_duration: active ? "none" : BAN_FOREVER });
    }
    await audit(active ? "EVALUATOR_ENABLED" : "EVALUATOR_DISABLED", { userId: admin.id, entityType: "evaluator", entityId: id });
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
    const db = createAdminClient();
    const { data: evaluator } = await db.from("evaluators").select("user_id").eq("id", parsed.data.id).single();
    if (!evaluator?.user_id) return fail("VALIDATION", "Evaluator has no login.");
    const { error } = await db.auth.admin.updateUserById(evaluator.user_id, { password: parsed.data.password });
    if (error) return fail("VALIDATION", "Could not reset the password.");
    await audit("EVALUATOR_PASSWORD_RESET", { userId: admin.id, entityType: "evaluator", entityId: id });
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
    const parsed = z
      .object({ id: uuidSchema, status: z.enum(["ACTIVE", "WITHDRAWN", "DISQUALIFIED"]) })
      .safeParse({ id, status });
    if (!parsed.success) return invalid(parsed.error);
    const { error } = await createAdminClient().from("students").update({ status: parsed.data.status }).eq("id", id);
    if (error) return toFailure(error, "setStudentStatus");
    await audit("STUDENT_STATUS_CHANGED", { userId: admin.id, entityType: "student", entityId: id, metadata: { status } });
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
    const parsed = z
      .object({ id: uuidSchema, priority: z.number().int().min(1).max(100000).nullable() })
      .safeParse({ id, priority });
    if (!parsed.success) return invalid(parsed.error);
    const { error } = await createAdminClient().from("students").update({ tie_break_priority: parsed.data.priority }).eq("id", id);
    if (error) return toFailure(error, "setTieBreakPriority");
    await audit("TIE_BREAK_PRIORITY_SET", { userId: admin.id, entityType: "student", entityId: id, metadata: { priority } });
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

    const result = await importStudentRows(headers, rows, admin.id);
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
        : "Could not read the problem statement sheet. Check that it is shared with the service account.";
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
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("retry_failed_sync_jobs");
    if (error) return toFailure(error, "retryFailedSync");
    scheduleSheetSync();
    revalidatePath("/admin/sync");
    return ok({ count: data ?? 0 });
  } catch (error) {
    return toFailure(error, "retryFailedSync");
  }
}

export async function fullResync(): Promise<ActionResult<{ count: number }>> {
  try {
    await requireAdmin();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("enqueue_full_resync");
    if (error) return toFailure(error, "fullResync");
    scheduleSheetSync();
    revalidatePath("/admin/sync");
    return ok({ count: data ?? 0 });
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
    await requireAdmin();
    const parsed = reasonInput.safeParse({ id: evaluationId, reason });
    if (!parsed.success) return invalid(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.rpc("admin_reopen_evaluation", { p_evaluation_id: parsed.data.id, p_reason: parsed.data.reason });
    if (error) return toFailure(error, "reopenEvaluation");
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
    await requireAdmin();
    const parsed = reasonInput.safeParse({ id: evaluationId, reason });
    if (!parsed.success) return invalid(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.rpc("admin_release_evaluation", { p_evaluation_id: parsed.data.id, p_reason: parsed.data.reason });
    if (error) return toFailure(error, "releaseEvaluation");
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
    const { error } = await createAdminClient()
      .from("app_settings")
      .update({
        allow_resubmission: parsed.data.allowResubmission,
        max_evaluations_per_evaluator: parsed.data.maxEvaluationsPerEvaluator,
        tie_breakers: parsed.data.tieBreakers,
        updated_by: admin.id,
      })
      .eq("id", true);
    if (error) return toFailure(error, "saveSettings");
    await audit("SETTINGS_UPDATED", { userId: admin.id, entityType: "app_settings", metadata: parsed.data });
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
    const { error } = await createAdminClient()
      .from("app_settings")
      .update({ form_field_mapping: parsed.data as unknown as Json, updated_by: admin.id })
      .eq("id", true);
    if (error) return toFailure(error, "saveFormMapping");
    await audit("FORM_MAPPING_UPDATED", { userId: admin.id, entityType: "app_settings" });
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
    const { criteria, ...settings } = parsed.data;
    const db = createAdminClient();
    const { error } = await db
      .from("app_settings")
      .update({
        sheet_writeback: {
          total_header: settings.totalHeader,
          evaluator_header: settings.evaluatorHeader,
          domains_header: settings.domainsHeader,
        },
        updated_by: admin.id,
      })
      .eq("id", true);
    if (error) return toFailure(error, "saveSheetWriteback");
    for (const c of criteria) {
      const { error: cErr } = await db.from("evaluation_criteria").update({ sheet_column: c.sheetColumn || null }).eq("id", c.id);
      if (cErr) return toFailure(cErr, "saveSheetWriteback");
    }
    await audit("SHEET_COLUMNS_UPDATED", { userId: admin.id, entityType: "app_settings", metadata: parsed.data });
    // Re-write every evaluated row into the (possibly re-mapped) columns.
    const supabase = await createClient();
    await supabase.rpc("enqueue_full_resync");
    scheduleSheetSync();
    revalidatePath("/admin/settings");
    return ok();
  } catch (error) {
    return toFailure(error, "saveSheetWriteback");
  }
}
