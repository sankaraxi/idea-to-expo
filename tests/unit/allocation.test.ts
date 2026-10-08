import { describe, expect, it } from "vitest";
import {
  fingerprintInput,
  planAllocation,
  validateCapacity,
  type AllocationInput,
} from "@/lib/allocation/plan";
import { SeededRandom, shuffle } from "@/lib/allocation/random";

function makeInput(students: number, evaluators: number, cap = 50, k = 1): AllocationInput {
  return {
    students: Array.from({ length: students }, (_, i) => ({
      id: `s-${String(i).padStart(4, "0")}`,
      existingEvaluatorIds: [],
    })),
    evaluators: Array.from({ length: evaluators }, (_, i) => ({
      id: `e-${String(i).padStart(2, "0")}`,
      name: `Evaluator ${i}`,
      currentLoad: 0,
      capacity: cap,
    })),
    evaluatorsPerStudent: k,
  };
}

function loads(assignments: { evaluatorId: string }[]) {
  const counts = new Map<string, number>();
  for (const a of assignments) counts.set(a.evaluatorId, (counts.get(a.evaluatorId) ?? 0) + 1);
  return [...counts.values()];
}

describe("SeededRandom / shuffle", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const a = shuffle(items, new SeededRandom("seed-1"));
    const b = shuffle(items, new SeededRandom("seed-1"));
    const c = shuffle(items, new SeededRandom("seed-2"));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
  });

  it("produces an approximately uniform distribution", () => {
    // Position of element 0 after shuffling 4 items, over many seeds.
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) counts[shuffle([0, 1, 2, 3], new SeededRandom(`s${i}`)).indexOf(0)]++;
    for (const c of counts) expect(c).toBeGreaterThan(850);
  });

  it("rejects invalid bounds", () => {
    expect(() => new SeededRandom("x").int(0)).toThrow(RangeError);
    expect(() => new SeededRandom("")).toThrow();
  });
});

describe("capacity validation", () => {
  it("allows 900 students across 20 evaluators at 50 each", () => {
    expect(validateCapacity(makeInput(900, 20, 50))).toBeNull();
  });

  it("blocks 1100 students against 1000 capacity and reports the shortfall", () => {
    const failure = validateCapacity(makeInput(1100, 20, 50));
    expect(failure).toMatchObject({
      code: "INSUFFICIENT_CAPACITY",
      additionalCapacityRequired: 100,
      summary: { assignmentsRequired: 1100, availableCapacity: 1000 },
    });
  });

  it("accounts for evaluators-per-student", () => {
    expect(validateCapacity(makeInput(900, 20, 50, 2))).toMatchObject({
      code: "INSUFFICIENT_CAPACITY",
      additionalCapacityRequired: 800,
    });
    expect(validateCapacity(makeInput(900, 20, 90, 2))).toBeNull();
    expect(validateCapacity(makeInput(10, 2, 50, 3))).toMatchObject({ code: "NOT_ENOUGH_EVALUATORS" });
  });

  it("reports nothing to allocate and no evaluators", () => {
    expect(validateCapacity(makeInput(0, 3))).toMatchObject({ code: "NOTHING_TO_ALLOCATE" });
    expect(validateCapacity(makeInput(5, 0))).toMatchObject({ code: "NO_EVALUATORS" });
  });

  it("never returns a partial plan when capacity is insufficient", () => {
    const result = planAllocation(makeInput(1100, 20, 50), "seed");
    expect(result.ok).toBe(false);
  });
});

describe("planAllocation", () => {
  it("assigns every student exactly once and balances to within one", () => {
    const result = planAllocation(makeInput(900, 20, 50), "seed");
    if (!result.ok) throw new Error(result.failure.code);
    expect(result.assignments).toHaveLength(900);
    expect(new Set(result.assignments.map((a) => a.studentId)).size).toBe(900);
    const l = loads(result.assignments);
    expect(Math.max(...l) - Math.min(...l)).toBeLessThanOrEqual(1);
    expect(Math.max(...l)).toBe(45);
  });

  it("handles uneven division (e.g. 905 over 20)", () => {
    const result = planAllocation(makeInput(905, 20, 50), "seed");
    if (!result.ok) throw new Error(result.failure.code);
    const l = loads(result.assignments).sort();
    expect(l.filter((n) => n === 46)).toHaveLength(5);
    expect(l.filter((n) => n === 45)).toHaveLength(15);
  });

  it("is not ordered by register number / input order", () => {
    const result = planAllocation(makeInput(100, 4, 50), "seed");
    if (!result.ok) throw new Error(result.failure.code);
    const firstEvaluatorStudents = result.assignments
      .filter((a) => a.evaluatorId === "e-00")
      .map((a) => Number(a.studentId.slice(2)));
    const contiguous = firstEvaluatorStudents.every((n, i, arr) => i === 0 || n === arr[i - 1] + 1);
    expect(contiguous).toBe(false);
  });

  it("gives distinct evaluators per student when k > 1 and stays balanced", () => {
    const result = planAllocation(makeInput(900, 20, 90, 2), "seed");
    if (!result.ok) throw new Error(result.failure.code);
    expect(result.assignments).toHaveLength(1800);
    const byStudent = new Map<string, Set<string>>();
    for (const a of result.assignments) {
      const set = byStudent.get(a.studentId) ?? new Set();
      set.add(a.evaluatorId);
      byStudent.set(a.studentId, set);
    }
    expect([...byStudent.values()].every((s) => s.size === 2)).toBe(true);
    const l = loads(result.assignments);
    expect(Math.max(...l) - Math.min(...l)).toBeLessThanOrEqual(1);
  });

  it("is reproducible for the same seed regardless of input order (preview == confirm)", () => {
    const input = makeInput(200, 7, 50);
    const reversed: AllocationInput = {
      ...input,
      students: [...input.students].reverse(),
      evaluators: [...input.evaluators].reverse(),
    };
    const a = planAllocation(input, "abc");
    const b = planAllocation(reversed, "abc");
    const c = planAllocation(input, "xyz");
    expect(a).toEqual(b);
    expect(a.ok && c.ok && a.assignments).not.toEqual(c.ok && c.assignments);
  });

  it("respects individual caps and existing loads (incremental)", () => {
    const input = makeInput(30, 3, 50);
    input.evaluators[0].capacity = 5;
    input.evaluators[1].currentLoad = 20;
    const result = planAllocation(input, "seed");
    if (!result.ok) throw new Error(result.failure.code);
    const summary = Object.fromEntries(result.evaluators.map((e) => [e.evaluatorId, e]));
    expect(summary["e-00"].total).toBeLessThanOrEqual(5);
    // Least-loaded first: evaluator 2 absorbs most new students.
    expect(summary["e-02"].added).toBeGreaterThan(summary["e-01"].added);
    expect(result.assignments).toHaveLength(30);
  });

  it("never re-assigns a student to an evaluator they already have", () => {
    const input = makeInput(10, 3, 50, 2);
    for (const s of input.students) s.existingEvaluatorIds = ["e-00"];
    input.evaluators[0].currentLoad = 10;
    const result = planAllocation(input, "seed");
    if (!result.ok) throw new Error(result.failure.code);
    expect(result.assignments).toHaveLength(10);
    expect(result.assignments.some((a) => a.evaluatorId === "e-00")).toBe(false);
  });

  it("reports unsatisfiable exclusions instead of producing a bad plan", () => {
    const input = makeInput(2, 2, 50, 1);
    input.evaluators[1].capacity = 0;
    input.evaluators[0].capacity = 1;
    input.evaluators[0].currentLoad = 0;
    // Capacity 1 overall, 2 needed -> capacity failure (validated up-front).
    expect(planAllocation(input, "s")).toMatchObject({ ok: false, failure: { code: "INSUFFICIENT_CAPACITY" } });
  });
});

describe("fingerprintInput", () => {
  it("changes when state changes and ignores ordering", () => {
    const input = makeInput(5, 2);
    const same = { ...input, students: [...input.students].reverse() };
    expect(fingerprintInput(input, "INITIAL")).toBe(fingerprintInput(same, "INITIAL"));
    const changed = { ...input, students: input.students.slice(1) };
    expect(fingerprintInput(input, "INITIAL")).not.toBe(fingerprintInput(changed, "INITIAL"));
    expect(fingerprintInput(input, "INITIAL")).not.toBe(fingerprintInput(input, "INCREMENTAL"));
  });
});
