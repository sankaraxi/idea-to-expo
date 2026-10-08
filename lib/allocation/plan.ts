import { createHash } from "node:crypto";
import { SeededRandom, shuffle } from "./random";

export type AllocationType = "INITIAL" | "INCREMENTAL" | "FULL_REALLOCATION";

export interface AllocationStudent {
  id: string;
  /** Evaluators this student keeps regardless of this allocation (live, surviving assignments). */
  existingEvaluatorIds: string[];
}

export interface AllocationEvaluator {
  id: string;
  name: string;
  /** Live assignments this evaluator keeps regardless of this allocation. */
  currentLoad: number;
  /** Effective cap: least(individual max, global max per evaluator). */
  capacity: number;
}

export interface AllocationInput {
  students: AllocationStudent[];
  evaluators: AllocationEvaluator[];
  evaluatorsPerStudent: number;
}

export interface PlannedAssignment {
  studentId: string;
  evaluatorId: string;
}

export interface EvaluatorPlanSummary {
  evaluatorId: string;
  name: string;
  existing: number;
  added: number;
  total: number;
  capacity: number;
}

export interface CapacitySummary {
  studentsNeedingAllocation: number;
  assignmentsRequired: number;
  availableCapacity: number;
  totalCapacity: number;
  activeEvaluators: number;
  evaluatorsPerStudent: number;
}

export type AllocationFailure =
  | { code: "NOTHING_TO_ALLOCATE"; summary: CapacitySummary }
  | { code: "NO_EVALUATORS"; summary: CapacitySummary }
  | { code: "NOT_ENOUGH_EVALUATORS"; summary: CapacitySummary }
  | { code: "INSUFFICIENT_CAPACITY"; summary: CapacitySummary; additionalCapacityRequired: number }
  | { code: "UNSATISFIABLE"; summary: CapacitySummary; studentId: string };

export type AllocationPlanResult =
  | {
      ok: true;
      seed: string;
      assignments: PlannedAssignment[];
      evaluators: EvaluatorPlanSummary[];
      summary: CapacitySummary;
    }
  | { ok: false; failure: AllocationFailure };

export function summarizeCapacity(input: AllocationInput): CapacitySummary {
  const k = input.evaluatorsPerStudent;
  let studentsNeedingAllocation = 0;
  let assignmentsRequired = 0;
  for (const s of input.students) {
    const missing = Math.max(0, k - s.existingEvaluatorIds.length);
    if (missing > 0) studentsNeedingAllocation++;
    assignmentsRequired += missing;
  }
  return {
    studentsNeedingAllocation,
    assignmentsRequired,
    availableCapacity: input.evaluators.reduce((sum, e) => sum + Math.max(0, e.capacity - e.currentLoad), 0),
    totalCapacity: input.evaluators.reduce((sum, e) => sum + e.capacity, 0),
    activeEvaluators: input.evaluators.length,
    evaluatorsPerStudent: k,
  };
}

/** Validates capacity without generating a plan. Never allocates partially. */
export function validateCapacity(input: AllocationInput): AllocationFailure | null {
  const summary = summarizeCapacity(input);
  if (input.evaluators.length === 0) return { code: "NO_EVALUATORS", summary };
  if (summary.assignmentsRequired === 0) return { code: "NOTHING_TO_ALLOCATE", summary };
  if (input.evaluatorsPerStudent > input.evaluators.length) return { code: "NOT_ENOUGH_EVALUATORS", summary };
  if (summary.assignmentsRequired > summary.availableCapacity) {
    return {
      code: "INSUFFICIENT_CAPACITY",
      summary,
      additionalCapacityRequired: summary.assignmentsRequired - summary.availableCapacity,
    };
  }
  return null;
}

/**
 * Randomised, balanced allocation.
 *
 * 1. Fisher–Yates shuffle students and evaluators with a seeded CSPRNG.
 * 2. Fill one "round" of evaluators-per-student at a time; for each student
 *    pick the least-loaded evaluator with spare capacity that the student does
 *    not already have. Ties resolve in the shuffled evaluator order, so which
 *    evaluators end up with one extra student is random, while loads never
 *    differ by more than one (absent per-evaluator caps).
 *
 * Deterministic for a given (input, seed) pair.
 */
export function planAllocation(input: AllocationInput, seed: string): AllocationPlanResult {
  const failure = validateCapacity(input);
  if (failure) return { ok: false, failure };

  const summary = summarizeCapacity(input);
  const random = new SeededRandom(seed);
  // Sort first so the result depends only on the set of ids and the seed,
  // never on the order rows came back from the database.
  const students = shuffle([...input.students].sort((a, b) => a.id.localeCompare(b.id)), random);
  const evaluators = shuffle([...input.evaluators].sort((a, b) => a.id.localeCompare(b.id)), random);

  const load = new Map(evaluators.map((e) => [e.id, e.currentLoad]));
  const added = new Map(evaluators.map((e) => [e.id, 0]));
  const taken = new Map(students.map((s) => [s.id, new Set(s.existingEvaluatorIds)]));
  const assignments: PlannedAssignment[] = [];

  for (let round = 0; round < input.evaluatorsPerStudent; round++) {
    for (const student of students) {
      const have = taken.get(student.id)!;
      if (have.size > round) continue;

      let best: AllocationEvaluator | null = null;
      for (const evaluator of evaluators) {
        const current = load.get(evaluator.id)!;
        if (current >= evaluator.capacity || have.has(evaluator.id)) continue;
        if (best === null || current < load.get(best.id)!) best = evaluator;
      }
      if (!best) return { ok: false, failure: { code: "UNSATISFIABLE", summary, studentId: student.id } };

      have.add(best.id);
      load.set(best.id, load.get(best.id)! + 1);
      added.set(best.id, added.get(best.id)! + 1);
      assignments.push({ studentId: student.id, evaluatorId: best.id });
    }
  }

  return {
    ok: true,
    seed,
    assignments,
    summary,
    evaluators: [...input.evaluators]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({
        evaluatorId: e.id,
        name: e.name,
        existing: e.currentLoad,
        added: added.get(e.id) ?? 0,
        total: load.get(e.id) ?? e.currentLoad,
        capacity: e.capacity,
      })),
  };
}

/**
 * Stable digest of everything the plan depends on. A preview is only
 * confirmable if the fingerprint of the current state still matches.
 */
export function fingerprintInput(input: AllocationInput, type: AllocationType): string {
  const canonical = {
    type,
    k: input.evaluatorsPerStudent,
    students: input.students
      .map((s) => `${s.id}:${[...s.existingEvaluatorIds].sort().join(",")}`)
      .sort(),
    evaluators: input.evaluators.map((e) => `${e.id}:${e.currentLoad}:${e.capacity}`).sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
