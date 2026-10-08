import "server-only";
import { AppError } from "@/lib/errors";
import type { AdminClient } from "@/lib/supabase/admin";
import { fetchAllPages } from "@/lib/supabase/paginate";
import {
  fingerprintInput,
  planAllocation,
  type AllocationFailure,
  type AllocationInput,
  type AllocationType,
  type EvaluatorPlanSummary,
  type CapacitySummary,
} from "./plan";
import { SeededRandom } from "./random";

export interface AllocationConfig {
  type: AllocationType;
  maxPerEvaluator: number;
  evaluatorsPerStudent: number;
}

export interface AllocationState {
  input: AllocationInput;
  liveAssignments: number;
  replaceable: number;
}

/**
 * Builds the planner input from the current database state.
 *  - INITIAL: only valid while no live assignments exist.
 *  - INCREMENTAL: keeps every live assignment; tops up students below N.
 *  - FULL_REALLOCATION: untouched (PENDING) assignments are dropped and
 *    re-drawn; anything already started/completed is kept.
 */
export async function loadAllocationState(db: AdminClient, config: AllocationConfig): Promise<AllocationState> {
  const [students, evaluators, assignments] = await Promise.all([
    fetchAllPages((from, to) =>
      db.from("students").select("id").eq("status", "ACTIVE").order("id").range(from, to),
    ),
    fetchAllPages((from, to) =>
      db.from("evaluators").select("id, name, max_assignments").eq("status", "ACTIVE").order("id").range(from, to),
    ),
    fetchAllPages((from, to) =>
      db
        .from("evaluation_assignments")
        .select("student_id, evaluator_id, status")
        .neq("status", "REPLACED")
        .order("id")
        .range(from, to),
    ),
  ]);

  if (config.type === "INITIAL" && assignments.length > 0) {
    throw new AppError(
      "INVALID_ALLOCATION_TYPE",
      "Assignments already exist. Use “Allocate unassigned students” or “Full reallocation”.",
    );
  }

  const kept =
    config.type === "FULL_REALLOCATION" ? assignments.filter((a) => a.status !== "PENDING") : assignments;

  const existingByStudent = new Map<string, string[]>();
  const loadByEvaluator = new Map<string, number>();
  for (const a of kept) {
    existingByStudent.set(a.student_id, [...(existingByStudent.get(a.student_id) ?? []), a.evaluator_id]);
    loadByEvaluator.set(a.evaluator_id, (loadByEvaluator.get(a.evaluator_id) ?? 0) + 1);
  }

  return {
    liveAssignments: assignments.length,
    replaceable: assignments.length - kept.length,
    input: {
      evaluatorsPerStudent: config.evaluatorsPerStudent,
      students: students.map((s) => ({ id: s.id, existingEvaluatorIds: existingByStudent.get(s.id) ?? [] })),
      evaluators: evaluators.map((e) => ({
        id: e.id,
        name: e.name,
        currentLoad: loadByEvaluator.get(e.id) ?? 0,
        capacity: Math.min(e.max_assignments, config.maxPerEvaluator),
      })),
    },
  };
}

export type AllocationPreview =
  | {
      ok: true;
      config: AllocationConfig;
      seed: string;
      fingerprint: string;
      summary: CapacitySummary;
      evaluators: EvaluatorPlanSummary[];
      assignmentCount: number;
      replaceable: number;
      /** A few sample pairs so admins can sanity-check randomness. */
      sample: { studentId: string; evaluatorId: string }[];
    }
  | { ok: false; config: AllocationConfig; failure: AllocationFailure };

export async function buildPreview(db: AdminClient, config: AllocationConfig, seed = SeededRandom.newSeed()) {
  const state = await loadAllocationState(db, config);
  const plan = planAllocation(state.input, seed);
  if (!plan.ok) return { ok: false, config, failure: plan.failure } satisfies AllocationPreview;
  return {
    ok: true,
    config,
    seed,
    fingerprint: fingerprintInput(state.input, config.type),
    summary: plan.summary,
    evaluators: plan.evaluators,
    assignmentCount: plan.assignments.length,
    replaceable: config.type === "FULL_REALLOCATION" ? state.replaceable : 0,
    sample: plan.assignments.slice(0, 8),
  } satisfies AllocationPreview;
}

/** Re-derives the exact previewed plan; refuses if anything changed since. */
export async function rebuildForConfirm(db: AdminClient, config: AllocationConfig, seed: string, fingerprint: string) {
  const state = await loadAllocationState(db, config);
  if (fingerprintInput(state.input, config.type) !== fingerprint) throw new AppError("STALE_PREVIEW");
  const plan = planAllocation(state.input, seed);
  if (!plan.ok) throw new AppError("STALE_PREVIEW");
  return plan;
}
