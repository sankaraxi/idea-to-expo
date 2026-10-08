"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireEvaluator } from "@/lib/auth/session";
import { fail, ok, toFailure, type ActionResult } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { scheduleSheetSync } from "@/lib/sheets/trigger";
import { createClient } from "@/lib/supabase/server";
import { evaluationInputSchema, uuidSchema } from "@/lib/validation/schemas";
import type { Json, SearchResultRow } from "@/types/database";

/**
 * Evaluator mutations. Evaluator identity is never sent by the client: the
 * RPCs resolve it from auth.uid(), lock the student row (one evaluator per
 * student) and the evaluator row (cap), and validate scores against criteria.
 */

export interface EvaluationInput {
  studentId: string;
  scores: Record<string, number>;
  remarks: string;
  domainIds: string[];
}

function parseInput(input: EvaluationInput) {
  const parsed = evaluationInputSchema.safeParse(input);
  if (!parsed.success) return { error: fail("VALIDATION", parsed.error.issues[0]?.message) };
  return { data: parsed.data };
}

export async function searchStudents(query: string): Promise<ActionResult<SearchResultRow[]>> {
  try {
    const user = await requireEvaluator();
    const q = z.string().trim().max(100).parse(query ?? "");
    if (q.length < 2) return ok([]);
    if (!rateLimit(`search:${user.id}`, 120, 60_000)) return fail("RATE_LIMITED");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("search_students", { p_query: q, p_limit: 20 });
    if (error) return toFailure(error, "searchStudents");
    return ok(data ?? []);
  } catch (error) {
    return toFailure(error, "searchStudents");
  }
}

export async function saveDraft(input: EvaluationInput): Promise<ActionResult<{ savedAt: string; version: number }>> {
  try {
    const user = await requireEvaluator();
    const parsed = parseInput(input);
    if (parsed.error) return parsed.error;
    if (!rateLimit(`draft:${user.id}`, 120, 60_000)) return fail("RATE_LIMITED");

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_evaluation_draft", {
      p_student_id: parsed.data.studentId,
      p_scores: parsed.data.scores as Json,
      p_remarks: parsed.data.remarks,
      p_domain_ids: parsed.data.domainIds,
    });
    if (error) return toFailure(error, "saveDraft");
    const result = data as { saved_at: string; version: number };
    return ok({ savedAt: result.saved_at, version: result.version });
  } catch (error) {
    return toFailure(error, "saveDraft");
  }
}

export async function submitEvaluation(
  input: EvaluationInput,
): Promise<ActionResult<{ submittedAt: string; totalScore: number; maxTotal: number; duplicate: boolean }>> {
  try {
    const user = await requireEvaluator();
    const parsed = parseInput(input);
    if (parsed.error) return parsed.error;
    if (!rateLimit(`submit:${user.id}`, 30, 60_000)) return fail("RATE_LIMITED");

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("submit_evaluation", {
      p_student_id: parsed.data.studentId,
      p_scores: parsed.data.scores as Json,
      p_remarks: parsed.data.remarks,
      p_domain_ids: parsed.data.domainIds,
    });
    if (error) return toFailure(error, "submitEvaluation");

    // Supabase has committed; Google Sheets catches up asynchronously.
    scheduleSheetSync();
    revalidatePath("/evaluator", "layout");
    const r = data as { submitted_at: string; total_score: number; max_total: number; duplicate: boolean };
    return ok({ submittedAt: r.submitted_at, totalScore: r.total_score, maxTotal: r.max_total, duplicate: r.duplicate });
  } catch (error) {
    return toFailure(error, "submitEvaluation");
  }
}

/** Give back a student this evaluator started but has not submitted. */
export async function releaseMyEvaluation(studentId: string): Promise<ActionResult> {
  try {
    await requireEvaluator();
    const id = uuidSchema.safeParse(studentId);
    if (!id.success) return fail("VALIDATION");
    const supabase = await createClient();
    const { error } = await supabase.rpc("release_my_evaluation", { p_student_id: id.data });
    if (error) return toFailure(error, "releaseMyEvaluation");
    scheduleSheetSync();
    revalidatePath("/evaluator", "layout");
    return ok();
  } catch (error) {
    return toFailure(error, "releaseMyEvaluation");
  }
}
