import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { CriterionRow, DomainRow, MyEvaluationRow, StudentForEvaluation } from "@/types/database";

/**
 * Evaluator reads, all through the user-scoped client: RLS and the
 * SECURITY DEFINER search/detail functions decide what is visible.
 */

export const getMyEvaluations = cache(async (): Promise<MyEvaluationRow[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("my_evaluations")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(1000);
  if (error) throw new Error(error.message);
  return data ?? [];
});

/** Effective cap = least(individual max, global max). */
export const getMyQuota = cache(async (evaluatorId: string) => {
  const supabase = await createClient();
  const [{ data: me }, { data: settings }, rows] = await Promise.all([
    supabase.from("evaluators").select("max_evaluations").eq("id", evaluatorId).single(),
    supabase.from("app_settings").select("max_evaluations_per_evaluator").single(),
    getMyEvaluations(),
  ]);
  const cap = Math.min(me?.max_evaluations ?? 50, settings?.max_evaluations_per_evaluator ?? 50);
  const completed = rows.filter((r) => r.status === "COMPLETED").length;
  const inProgress = rows.length - completed;
  return {
    cap,
    completed,
    inProgress,
    claimed: rows.length,
    remaining: Math.max(0, cap - rows.length),
    percent: cap === 0 ? 0 : Math.round((completed / cap) * 100),
  };
});

export const getActiveCriteria = cache(async (): Promise<CriterionRow[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("evaluation_criteria")
    .select("*")
    .eq("is_active", true)
    .order("sort_order")
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
});

export const getActiveDomains = cache(async (): Promise<DomainRow[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase.from("domains").select("*").eq("is_active", true).order("sort_order").order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
});

export async function getStudentForEvaluation(studentId: string): Promise<StudentForEvaluation | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_student_for_evaluation", { p_student_id: studentId });
  if (error) throw new Error(error.message);
  return (data as unknown as StudentForEvaluation | null) ?? null;
}
