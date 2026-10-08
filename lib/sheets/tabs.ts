import type { RankedStudent } from "@/lib/results/ranking";
import type {
  DashboardStats,
  EvaluationOverviewRow,
  EvaluatorProgressRow,
  StudentOverviewRow,
} from "@/types/database";
import type { CellValue } from "./api";
import type { KeyedRecord, TabDefinition } from "./engine";

/** Tabs of the optional reporting spreadsheet (GOOGLE_SHEET_ID). */
export const TABS = {
  STUDENT: {
    title: "Students",
    headers: [
      "Register Number", "Name", "Gender", "Department", "Section", "Email", "Submission Status", "PPT URL",
      "Evaluation Status", "Evaluator", "Updated At", "Sync Key",
    ],
  },
  EVALUATOR: {
    title: "Evaluators",
    headers: ["Evaluator ID", "Evaluator Name", "Email", "Evaluated", "In Progress", "Limit", "Remaining", "Status", "Sync Key"],
  },
  EVALUATION: {
    title: "Evaluations",
    headers: [
      "Register Number", "Student Name", "Department", "Evaluator", "Total", "Max", "Percentage", "Criteria Scores",
      "Domains", "Remarks", "Status", "Submitted At", "Updated At", "Sync Key",
    ],
  },
  RESULTS: {
    title: "Results",
    headers: ["Rank", "Register Number", "Student Name", "Department", "Total", "Max", "Percentage", "Domains", "Evaluator"],
  },
  DASHBOARD: {
    title: "Dashboard",
    headers: ["Metric", "Value"],
  },
} as const satisfies Record<string, TabDefinition>;

export const ALL_TABS: TabDefinition[] = Object.values(TABS);

export function formatTimestamp(iso: string | null | undefined, timeZone = process.env.SHEETS_TIMEZONE || "Asia/Kolkata") {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(new Date(iso))
    .replace(",", "");
}

export const evaluatorDisplayId = (e: { id: string; employee_id: string | null }) =>
  e.employee_id || `EV-${e.id.slice(0, 8).toUpperCase()}`;

const pct = (total: number | null, max: number | null) =>
  total === null || !max ? "" : `${Math.round((total / max) * 1000) / 10}%`;

export function studentRecord(s: StudentOverviewRow): KeyedRecord {
  return {
    key: s.id,
    values: [
      s.register_number,
      s.name,
      s.gender ?? "",
      s.department ?? "",
      s.section ?? "",
      s.email ?? "",
      s.submission_status,
      s.ppt_url ?? "",
      s.evaluation_status,
      s.evaluator_name ?? "",
      formatTimestamp(s.updated_at),
    ],
  };
}

export function evaluatorRecord(e: EvaluatorProgressRow): KeyedRecord {
  const completed = Number(e.completed_count);
  const claimed = Number(e.claimed_count);
  return {
    key: e.evaluator_id,
    values: [
      evaluatorDisplayId({ id: e.evaluator_id, employee_id: e.employee_id }),
      e.name,
      e.email,
      completed,
      Number(e.in_progress_count),
      e.evaluation_cap,
      Math.max(0, e.evaluation_cap - claimed),
      e.status,
    ],
  };
}

export function criteriaSummary(scores: Record<string, number>, criteria: readonly { id: string; name: string; max_marks: number }[]) {
  return criteria
    .filter((c) => scores[c.id] !== undefined)
    .map((c) => `${c.name}: ${scores[c.id]}/${c.max_marks}`)
    .join("; ");
}

export function evaluationRecord(
  e: EvaluationOverviewRow,
  criteria: readonly { id: string; name: string; max_marks: number }[],
): KeyedRecord {
  const done = e.status === "COMPLETED";
  return {
    key: e.evaluation_id,
    values: [
      e.register_number,
      e.student_name,
      e.department ?? "",
      e.evaluator_name,
      done ? (e.total_score ?? "") : "",
      done ? (e.max_total ?? "") : "",
      done ? pct(e.total_score, e.max_total) : "",
      done ? criteriaSummary(e.scores, criteria) : "",
      done ? (e.domains ?? "") : "",
      done ? (e.remarks ?? "") : "",
      done ? "COMPLETED" : "REOPENED",
      formatTimestamp(e.submitted_at),
      formatTimestamp(e.updated_at),
    ],
  };
}

/** Row for an evaluation that no longer exists (released by an admin/evaluator). */
export function releasedEvaluationRecord(id: string): KeyedRecord {
  return { key: id, values: ["", "", "", "", "", "", "", "", "", "", "RELEASED", "", formatTimestamp(new Date().toISOString())] };
}

export function resultRows(ranked: readonly RankedStudent[]): CellValue[][] {
  return ranked.map((r) => [
    r.rank,
    r.registerNumber,
    r.name,
    r.department ?? "",
    r.total,
    r.maxTotal,
    `${r.percentage}%`,
    r.domains ?? "",
    r.evaluatorName ?? "",
  ]);
}

export function dashboardRows(stats: DashboardStats, now = new Date().toISOString()): CellValue[][] {
  const students = Number(stats.total_students);
  const completed = Number(stats.completed_evaluations);
  return [
    ["Total Students", students],
    ["Ideas Submitted", stats.ideas_submitted],
    ["Evaluators", stats.total_evaluators],
    ["Evaluation Capacity", stats.evaluation_capacity],
    ["Evaluated", completed],
    ["In Progress", stats.in_progress_evaluations],
    ["Not Evaluated", stats.not_evaluated],
    ["Average Score %", stats.average_percentage ?? ""],
    ["Completion %", students === 0 ? "0%" : `${((completed / students) * 100).toFixed(1)}%`],
    ["Event Status", stats.event_status],
    ["Last Updated", formatTimestamp(now)],
  ];
}
