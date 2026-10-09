import "server-only";
import { cache } from "react";
import { listActiveCriteria, listActiveDomains } from "@/lib/services/criteria";
import { getEvaluatorStats, getStudentForEvaluation as loadStudent, listMyEvaluations } from "@/lib/services/evaluations";
import type { CriterionRow, DomainRow, MyEvaluationRow, StudentForEvaluation } from "@/types/database";

/**
 * Evaluator reads. Every function takes the evaluatorId from the signed-in
 * session (see the pages) so an evaluator can only ever see their own work.
 */
export const getMyEvaluations = cache((evaluatorId: string): Promise<MyEvaluationRow[]> => listMyEvaluations(evaluatorId));

export const getMyStats = cache((evaluatorId: string) => getEvaluatorStats(evaluatorId));

export const getActiveCriteria = cache((): Promise<CriterionRow[]> => listActiveCriteria());

export const getActiveDomains = cache((): Promise<DomainRow[]> => listActiveDomains());

export function getStudentForEvaluation(evaluatorId: string, studentId: string): Promise<StudentForEvaluation | null> {
  return loadStudent(evaluatorId, studentId);
}
