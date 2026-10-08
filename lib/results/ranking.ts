/**
 * Results & ranking.
 *
 * Final score = arithmetic mean of all COMPLETED evaluator scores.
 * Ordering = final score desc, then the configured tie-breakers in order.
 * Students equal on the final score and on every tie-breaker share a rank
 * (standard competition ranking: 1, 2, 2, 4).
 *
 * Tie-breakers are small comparator plugins so rules can be added without
 * touching the ranking loop.
 */

export interface StudentScores {
  studentId: string;
  registerNumber: string;
  name: string;
  department: string | null;
  scores: number[];
  tieBreakPriority?: number | null;
}

export interface RankedStudent extends StudentScores {
  rank: number;
  finalScore: number;
  evaluationCount: number;
  minScore: number;
  maxScore: number;
  tied: boolean;
}

type Comparator = (a: ScoredStudent, b: ScoredStudent) => number;

interface ScoredStudent extends StudentScores {
  sum: number;
  count: number;
  min: number;
  max: number;
}

export const TIE_BREAKERS = {
  MIN_SCORE_DESC: {
    label: "Higher minimum evaluator score",
    compare: ((a, b) => b.min - a.min) as Comparator,
  },
  MAX_SCORE_DESC: {
    label: "Higher maximum evaluator score",
    compare: ((a, b) => b.max - a.max) as Comparator,
  },
  EVALUATION_COUNT_DESC: {
    label: "More completed evaluations",
    compare: ((a, b) => b.count - a.count) as Comparator,
  },
  ADMIN_PRIORITY_ASC: {
    label: "Admin-defined priority (lower wins)",
    compare: ((a, b) =>
      (a.tieBreakPriority ?? Number.POSITIVE_INFINITY) - (b.tieBreakPriority ?? Number.POSITIVE_INFINITY) ||
      0) as Comparator,
  },
  REGISTER_NUMBER_ASC: {
    label: "Register number (ascending)",
    compare: ((a, b) => a.registerNumber.localeCompare(b.registerNumber)) as Comparator,
  },
} as const satisfies Record<string, { label: string; compare: Comparator }>;

export type TieBreakerId = keyof typeof TIE_BREAKERS;

export function isTieBreakerId(value: string): value is TieBreakerId {
  return Object.hasOwn(TIE_BREAKERS, value);
}

/** Compares exact means via cross-multiplication (no floating point drift). */
const byAverageDesc: Comparator = (a, b) => b.sum * a.count - a.sum * b.count;

function safeCompare(compare: Comparator, a: ScoredStudent, b: ScoredStudent): number {
  const result = compare(a, b);
  return Number.isNaN(result) ? 0 : result;
}

export interface RankingOptions {
  tieBreakers: readonly string[];
  /** Include students with no completed evaluation (unranked, at the end). Default false. */
  includeUnevaluated?: boolean;
}

export function rankStudents(
  students: readonly StudentScores[],
  options: RankingOptions,
): { ranked: RankedStudent[]; unevaluated: StudentScores[] } {
  const rules = options.tieBreakers.filter(isTieBreakerId).map((id) => TIE_BREAKERS[id].compare);
  const rankComparators: Comparator[] = [byAverageDesc, ...rules];

  const scored: ScoredStudent[] = [];
  const unevaluated: StudentScores[] = [];
  for (const s of students) {
    const valid = s.scores.filter((n) => Number.isInteger(n) && n >= 1 && n <= 10);
    if (valid.length === 0) {
      unevaluated.push(s);
      continue;
    }
    scored.push({
      ...s,
      scores: valid,
      sum: valid.reduce((x, y) => x + y, 0),
      count: valid.length,
      min: Math.min(...valid),
      max: Math.max(...valid),
    });
  }

  const compareRank = (a: ScoredStudent, b: ScoredStudent) => {
    for (const compare of rankComparators) {
      const result = safeCompare(compare, a, b);
      if (result !== 0) return result;
    }
    return 0;
  };

  scored.sort((a, b) => compareRank(a, b) || a.registerNumber.localeCompare(b.registerNumber));

  const ranked: RankedStudent[] = [];
  scored.forEach((s, index) => {
    const previous = ranked[index - 1];
    const tiedWithPrevious = index > 0 && compareRank(scored[index - 1], s) === 0;
    const rank = tiedWithPrevious ? previous.rank : index + 1;
    if (tiedWithPrevious) previous.tied = true;
    ranked.push({
      studentId: s.studentId,
      registerNumber: s.registerNumber,
      name: s.name,
      department: s.department,
      scores: s.scores,
      tieBreakPriority: s.tieBreakPriority,
      rank,
      finalScore: Math.round((s.sum / s.count) * 100) / 100,
      evaluationCount: s.count,
      minScore: s.min,
      maxScore: s.max,
      tied: tiedWithPrevious,
    });
  });

  return { ranked, unevaluated: options.includeUnevaluated ? unevaluated : [] };
}
