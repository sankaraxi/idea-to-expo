"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireEvaluator } from "@/lib/auth/session";
import { fail, ok, toFailure, type ActionResult } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import * as evaluations from "@/lib/services/evaluations";
import { scheduleSheetSync } from "@/lib/sheets/trigger";
import { evaluationInputSchema, uuidSchema } from "@/lib/validation/schemas";
import type { SearchResultRow } from "@/types/database";

/**
 * Evaluator mutations. The evaluator id comes from the authenticated session
 * (requireEvaluator), never from the request; only the student id, scores,
 * remarks and domains cross the wire.
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
    return ok(await evaluations.searchStudents(user.evaluatorId, q, 20));
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
    const result = await evaluations.saveDraft(user.evaluatorId, parsed.data);
    return ok({ savedAt: result.savedAt, version: result.version });
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

    const result = await evaluations.submitEvaluation(user.evaluatorId, parsed.data);
    // The database has committed; Google Sheets catches up asynchronously.
    scheduleSheetSync();
    revalidatePath("/evaluator", "layout");
    return ok({ submittedAt: result.submittedAt, totalScore: result.totalScore, maxTotal: result.maxTotal, duplicate: result.duplicate });
  } catch (error) {
    return toFailure(error, "submitEvaluation");
  }
}

/** Give back a student this evaluator started but has not submitted. */
export async function releaseMyEvaluation(studentId: string): Promise<ActionResult> {
  try {
    const user = await requireEvaluator();
    const id = uuidSchema.safeParse(studentId);
    if (!id.success) return fail("VALIDATION");
    await evaluations.releaseMyEvaluation(user.evaluatorId, id.data);
    scheduleSheetSync();
    revalidatePath("/evaluator", "layout");
    return ok();
  } catch (error) {
    return toFailure(error, "releaseMyEvaluation");
  }
}
