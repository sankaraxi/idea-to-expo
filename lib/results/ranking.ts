/**
 * Results & ranking.
 *
 * Each student has exactly one evaluation; its total is the sum of the
 * criterion scores. Students are ordered by total / max_total (identical to
 * ordering by total while the criteria set is unchanged, and still fair if
 * criteria were added mid-event), then by the configured tie-breakers.
 * Students equal on everything share a rank (1, 2, 2, 4).
 *
 * Tie-breaker ids:
 *   CRITERION:<uuid>     higher score in that criterion
 *   ADMIN_PRIORITY_ASC   admin-assigned priority (lower wins)
 *   REGISTER_NUMBER_ASC  register number order (always breaks ties)
 */

import type { Decision } from "@/lib/decision";

export interface StudentResult {
  studentId: string;
  registerNumber: string;
  name: string;
  department: string | null;
  total: number;
  maxTotal: number;
  criterionScores: Record<string, number>;
  tieBreakPriority?: number | null;
  domains?: string | null;
  evaluatorName?: string | null;
  decision?: Decision | null;
}

export interface RankedStudent extends StudentResult {
  rank: number;
  percentage: number;
  tied: boolean;
}

type Comparator = (a: StudentResult, b: StudentResult) => number;

const STATIC_TIE_BREAKERS: Record<string, { label: string; compare: Comparator }> = {
  ADMIN_PRIORITY_ASC: {
    label: "Admin-defined priority (lower wins)",
    compare: (a, b) => {
      const x = a.tieBreakPriority ?? Number.POSITIVE_INFINITY;
      const y = b.tieBreakPriority ?? Number.POSITIVE_INFINITY;
      return x === y ? 0 : x < y ? -1 : 1;
    },
  },
  REGISTER_NUMBER_ASC: {
    label: "Register number (ascending)",
    compare: (a, b) => a.registerNumber.localeCompare(b.registerNumber),
  },
};

export function tieBreakerOptions(criteria: readonly { id: string; name: string }[]) {
  return [
    ...criteria.map((c) => ({ id: `CRITERION:${c.id}`, label: `Higher “${c.name}” score` })),
    ...Object.entries(STATIC_TIE_BREAKERS).map(([id, t]) => ({ id, label: t.label })),
  ];
}

export function isTieBreakerId(id: string): boolean {
  return Object.hasOwn(STATIC_TIE_BREAKERS, id) || /^CRITERION:[0-9a-f-]{36}$/i.test(id);
}

function comparatorFor(id: string): Comparator | null {
  if (Object.hasOwn(STATIC_TIE_BREAKERS, id)) return STATIC_TIE_BREAKERS[id].compare;
  const criterion = id.match(/^CRITERION:(.+)$/)?.[1];
  if (!criterion) return null;
  return (a, b) => (b.criterionScores[criterion] ?? -1) - (a.criterionScores[criterion] ?? -1);
}

/** Exact comparison of total/maxTotal ratios (no floating point). */
const byPercentageDesc: Comparator = (a, b) => b.total * a.maxTotal - a.total * b.maxTotal;

export function rankStudents(results: readonly StudentResult[], tieBreakers: readonly string[]): RankedStudent[] {
  const valid = results.filter((r) => Number.isFinite(r.total) && r.maxTotal > 0);
  const comparators = [byPercentageDesc, ...tieBreakers.map(comparatorFor).filter((c): c is Comparator => c !== null)];
  const compare = (a: StudentResult, b: StudentResult) => {
    for (const c of comparators) {
      const r = c(a, b);
      if (r !== 0) return r;
    }
    return 0;
  };
  const sorted = [...valid].sort((a, b) => compare(a, b) || a.registerNumber.localeCompare(b.registerNumber));

  const ranked: RankedStudent[] = [];
  sorted.forEach((s, i) => {
    const tiedWithPrevious = i > 0 && compare(sorted[i - 1], s) === 0;
    if (tiedWithPrevious) ranked[i - 1].tied = true;
    ranked.push({
      ...s,
      rank: tiedWithPrevious ? ranked[i - 1].rank : i + 1,
      percentage: Math.round((s.total / s.maxTotal) * 1000) / 10,
      tied: tiedWithPrevious,
    });
  });
  return ranked;
}
