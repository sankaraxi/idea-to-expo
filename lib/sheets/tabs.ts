import type { RankedStudent } from "@/lib/results/ranking";
import type {
  AllocationBatchRow,
  AssignmentRow,
  DashboardStats,
  EvaluationRow,
  EvaluatorProgressRow,
  EvaluatorRow,
  IdeaRow,
  StudentRow,
} from "@/types/database";
import type { CellValue } from "./api";
import type { KeyedRecord, TabDefinition } from "./engine";

export const TABS = {
  STUDENT: {
    title: "Students",
    headers: ["Register Number", "Name", "Department", "Section", "Email", "Submission Status", "PPT URL", "Created At", "Updated At", "Sync Key"],
  },
  EVALUATOR: {
    title: "Evaluators",
    headers: ["Evaluator ID", "Evaluator Name", "Email", "Assigned Count", "Completed Count", "Pending Count", "Progress", "Status", "Sync Key"],
  },
  ASSIGNMENT: {
    title: "Assignments",
    headers: ["Register Number", "Student Name", "Evaluator ID", "Evaluator Name", "Allocation Batch", "Assigned At", "Status", "Sync Key"],
  },
  EVALUATION: {
    title: "Evaluations",
    headers: ["Register Number", "Student Name", "Evaluator", "Score", "Remarks", "Status", "Submitted At", "Updated At", "Sync Key"],
  },
  RESULTS: {
    title: "Results",
    headers: ["Rank", "Register Number", "Student Name", "Department", "Final Score", "Evaluation Count"],
  },
  DASHBOARD: {
    title: "Dashboard",
    headers: ["Metric", "Value"],
  },
} as const satisfies Record<string, TabDefinition>;

export const ALL_TABS: TabDefinition[] = Object.values(TABS);

/** Sheets show local, human-readable timestamps (IST by default). */
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

export const evaluatorDisplayId = (e: Pick<EvaluatorRow, "id" | "employee_id">) =>
  e.employee_id || `EV-${e.id.slice(0, 8).toUpperCase()}`;

export function studentRecord(
  s: Pick<StudentRow, "id" | "register_number" | "name" | "department" | "section" | "email" | "created_at" | "updated_at">,
  idea: Pick<IdeaRow, "submission_status" | "ppt_url" | "updated_at"> | undefined,
): KeyedRecord {
  const updated = idea && idea.updated_at > s.updated_at ? idea.updated_at : s.updated_at;
  return {
    key: s.id,
    values: [
      s.register_number,
      s.name,
      s.department ?? "",
      s.section ?? "",
      s.email ?? "",
      idea?.submission_status ?? "MISSING",
      idea?.ppt_url ?? "",
      formatTimestamp(s.created_at),
      formatTimestamp(updated),
    ],
  };
}

export function evaluatorRecord(e: EvaluatorProgressRow): KeyedRecord {
  const assigned = Number(e.assigned_count);
  const completed = Number(e.completed_count);
  return {
    key: e.evaluator_id,
    values: [
      evaluatorDisplayId({ id: e.evaluator_id, employee_id: e.employee_id }),
      e.name,
      e.email,
      assigned,
      completed,
      assigned - completed,
      assigned === 0 ? "0%" : `${Math.round((completed / assigned) * 100)}%`,
      e.status,
    ],
  };
}

export function assignmentRecord(
  a: Pick<AssignmentRow, "id" | "assigned_at" | "status">,
  student: Pick<StudentRow, "register_number" | "name"> | undefined,
  evaluator: Pick<EvaluatorRow, "id" | "name" | "employee_id"> | undefined,
  batch: Pick<AllocationBatchRow, "id" | "allocation_type" | "created_at"> | undefined,
): KeyedRecord {
  return {
    key: a.id,
    values: [
      student?.register_number ?? "",
      student?.name ?? "",
      evaluator ? evaluatorDisplayId(evaluator) : "",
      evaluator?.name ?? "",
      batch ? `${batch.allocation_type} ${formatTimestamp(batch.created_at)}` : "MANUAL",
      formatTimestamp(a.assigned_at),
      a.status,
    ],
  };
}

export function evaluationRecord(
  e: Pick<EvaluationRow, "id" | "score" | "remarks" | "status" | "submitted_at" | "updated_at">,
  student: Pick<StudentRow, "register_number" | "name"> | undefined,
  evaluator: Pick<EvaluatorRow, "name"> | undefined,
): KeyedRecord {
  return {
    key: e.id,
    values: [
      student?.register_number ?? "",
      student?.name ?? "",
      evaluator?.name ?? "",
      e.status === "COMPLETED" ? (e.score ?? "") : "",
      e.status === "COMPLETED" ? (e.remarks ?? "") : "",
      e.status === "COMPLETED" ? "COMPLETED" : "REOPENED",
      formatTimestamp(e.submitted_at),
      formatTimestamp(e.updated_at),
    ],
  };
}

export function resultRows(ranked: readonly RankedStudent[]): CellValue[][] {
  return ranked.map((r) => [r.rank, r.registerNumber, r.name, r.department ?? "", r.finalScore, r.evaluationCount]);
}

export function dashboardRows(stats: DashboardStats, now = new Date().toISOString()): CellValue[][] {
  const total = Number(stats.total_assignments);
  const completed = Number(stats.completed_evaluations);
  return [
    ["Total Students", stats.total_students],
    ["Ideas Submitted", stats.ideas_submitted],
    ["Total Evaluators", stats.total_evaluators],
    ["Assigned Students", stats.assigned_students],
    ["Total Assignments", total],
    ["Completed Evaluations", completed],
    ["In Progress Evaluations", stats.in_progress_evaluations],
    ["Pending Evaluations", stats.pending_evaluations],
    ["Average Score", stats.average_score ?? ""],
    ["Completion %", total === 0 ? "0%" : `${((completed / total) * 100).toFixed(1)}%`],
    ["Event Status", stats.event_status],
    ["Last Updated", formatTimestamp(now)],
  ];
}
