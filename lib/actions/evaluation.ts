"use server";

import { revalidatePath } from "next/cache";
import { requireEvaluator } from "@/lib/auth/session";
import { fail, ok, toFailure, type ActionResult } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { scheduleSheetSync } from "@/lib/sheets/trigger";
import { createClient } from "@/lib/supabase/server";
import { saveDraftSchema, submitEvaluationSchema } from "@/lib/validation/schemas";

/**
 * Evaluator mutations. The evaluator's identity is never taken from the
 * request: the RPCs resolve it from auth.uid() and lock the assignment row.
 * Only the assignment id, score and remarks cross the wire.
 */

export async function saveDraft(input: {
  assignmentId: string;
  score: number | null;
  remarks: string;
}): Promise<ActionResult<{ savedAt: string; version: number }>> {
  try {
    const user = await requireEvaluator();
    const parsed = saveDraftSchema.safeParse(input);
    if (!parsed.success) return fail("VALIDATION", parsed.error.issues[0]?.message);
    if (!rateLimit(`draft:${user.id}`, 120, 60_000)) return fail("RATE_LIMITED");

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_evaluation_draft", {
      p_assignment_id: parsed.data.assignmentId,
      p_score: parsed.data.score,
      p_remarks: parsed.data.remarks,
    });
    if (error) return toFailure(error, "saveDraft");
    const result = data as { saved_at: string; version: number };
    return ok({ savedAt: result.saved_at, version: result.version });
  } catch (error) {
    return toFailure(error, "saveDraft");
  }
}

export async function submitEvaluation(input: {
  assignmentId: string;
  score: number | null;
  remarks: string;
}): Promise<ActionResult<{ submittedAt: string; duplicate: boolean }>> {
  try {
    const user = await requireEvaluator();
    const parsed = submitEvaluationSchema.safeParse(input);
    if (!parsed.success) {
      return fail("VALIDATION", parsed.error.issues[0]?.message, parsed.error.flatten().fieldErrors as Record<string, string[]>);
    }
    if (!rateLimit(`submit:${user.id}`, 30, 60_000)) return fail("RATE_LIMITED");

    const supabase = await createClient();
    const { data, error } = await supabase.rpc("submit_evaluation", {
      p_assignment_id: parsed.data.assignmentId,
      p_score: parsed.data.score,
      p_remarks: parsed.data.remarks,
    });
    if (error) return toFailure(error, "submitEvaluation");

    // Supabase has committed; the sheet catches up asynchronously.
    scheduleSheetSync();
    revalidatePath("/evaluator");
    const result = data as { submitted_at: string; duplicate: boolean };
    return ok({ submittedAt: result.submitted_at, duplicate: result.duplicate });
  } catch (error) {
    return toFailure(error, "submitEvaluation");
  }
}
