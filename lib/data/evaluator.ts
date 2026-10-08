import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { MyAssignmentRow } from "@/types/database";

/**
 * All reads here use the user-scoped client: RLS + the my_assignments view
 * guarantee an evaluator only ever receives their own assignments.
 * (~50 rows per evaluator, so the list is fetched whole and filtered client-side.)
 */
export const getMyAssignments = cache(async (): Promise<MyAssignmentRow[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("my_assignments")
    .select("*")
    .order("register_number")
    .limit(1000);
  if (error) throw new Error(error.message);
  return data ?? [];
});

export function progressOf(rows: readonly MyAssignmentRow[]) {
  const assigned = rows.length;
  const completed = rows.filter((r) => r.assignment_status === "COMPLETED").length;
  const inProgress = rows.filter((r) => r.assignment_status === "IN_PROGRESS").length;
  return {
    assigned,
    completed,
    inProgress,
    pending: assigned - completed,
    percent: assigned === 0 ? 0 : Math.round((completed / assigned) * 100),
  };
}

/** Next not-yet-completed assignment after `currentId` (wrapping), in list order. */
export function nextPendingAssignment(rows: readonly MyAssignmentRow[], currentId?: string) {
  const start = currentId ? rows.findIndex((r) => r.assignment_id === currentId) : -1;
  for (let i = 1; i <= rows.length; i++) {
    const row = rows[(start + i + rows.length) % rows.length];
    if (row && row.assignment_status !== "COMPLETED" && row.assignment_id !== currentId) return row;
  }
  return null;
}

export async function getEvaluationContext(assignmentId: string) {
  const supabase = await createClient();
  const { data: assignment, error } = await supabase
    .from("my_assignments")
    .select("*")
    .eq("assignment_id", assignmentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!assignment) return null;

  const [{ data: idea }, { data: evaluation }] = await Promise.all([
    supabase
      .from("ideas")
      .select("title, problem_statement, idea_description, team_details, ppt_url, other_details, submission_status")
      .eq("student_id", assignment.student_id)
      .maybeSingle(),
    supabase
      .from("evaluations")
      .select("id, score, remarks, status, submitted_at, updated_at, version")
      .eq("assignment_id", assignmentId)
      .maybeSingle(),
  ]);

  return { assignment, idea, evaluation };
}
