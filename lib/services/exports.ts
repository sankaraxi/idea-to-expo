import "server-only";
import ExcelJS from "exceljs";
import { pool, rows, rowsIn } from "@/lib/db/sql";
import { DECISION_LABELS, type Decision } from "@/lib/decision";
import { formatDateTime } from "@/lib/format";
import { loadRankedResults } from "@/lib/sheets/worker";
import { listCriteria } from "./criteria";

/**
 * Excel (.xlsx) downloads for the admin: students by status (Selected /
 * Waitlisted / Rejected) and students not yet evaluated.
 */

export const EXPORT_KINDS = ["selected", "waitlisted", "rejected", "not-evaluated"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const isExportKind = (v: unknown): v is ExportKind => EXPORT_KINDS.includes(v as ExportKind);

export const EXPORT_LABELS: Record<ExportKind, string> = {
  selected: "Selected",
  waitlisted: "Waitlisted",
  rejected: "Rejected",
  "not-evaluated": "Not evaluated",
};

const KIND_DECISION: Partial<Record<ExportKind, Decision>> = { selected: "SELECTED", waitlisted: "WAITLISTED", rejected: "REJECTED" };

interface Column {
  header: string;
  width: number;
  /** Long text columns wrap instead of stretching the sheet. */
  wrap?: boolean;
}

interface StudentDetail {
  id: string;
  gender: string | null;
  section: string | null;
  email: string | null;
  phone: string | null;
  problem_statement: string | null;
  remarks: string | null;
  submitted_at: string | null;
}

export interface ExportFile {
  filename: string;
  buffer: Buffer;
  count: number;
}

export async function buildExport(kind: ExportKind, department = ""): Promise<ExportFile> {
  const decision = KIND_DECISION[kind];
  const { columns, data } = decision ? await decisionSheet(decision, department) : await notEvaluatedSheet(department);
  const title = `${EXPORT_LABELS[kind]} students`;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Idea to Expo — Team SindhanAI";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(EXPORT_LABELS[kind], { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns.map((c) => ({ header: c.header, width: c.width }));
  sheet.addRows(data);

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A8A" } };
  header.alignment = { vertical: "middle" };
  header.height = 20;
  columns.forEach((c, i) => {
    if (c.wrap) sheet.getColumn(i + 1).alignment = { wrapText: true, vertical: "top" };
  });
  if (data.length) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const stamp = new Date().toISOString().slice(0, 10);
  const dept = department ? `-${department.replace(/[^A-Za-z0-9]+/g, "_")}` : "";
  return {
    filename: `${title.replace(/\s+/g, "-").toLowerCase()}${dept}-${stamp}.xlsx`,
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    count: data.length,
  };
}

async function detailsFor(studentIds: string[]) {
  if (!studentIds.length) return new Map<string, StudentDetail>();
  const list = await rowsIn<StudentDetail>(
    pool(),
    studentIds,
    (ids) => `SELECT s.id, s.gender, s.section, s.email, s.phone, i.problem_statement, ev.remarks, ev.submitted_at
                FROM students s
                LEFT JOIN ideas i ON i.student_id = s.id
                LEFT JOIN evaluations ev ON ev.student_id = s.id
               WHERE s.id IN ${ids}`,
  );
  return new Map(list.map((d) => [d.id, d]));
}

/** Evaluated students with the given status, in overall rank order. */
async function decisionSheet(decision: Decision, department: string) {
  const [ranked, criteria] = await Promise.all([loadRankedResults(), listCriteria()]);
  const picked = ranked.filter((r) => r.decision === decision && (!department || r.department === department));
  const details = await detailsFor(picked.map((r) => r.studentId));
  const scored = criteria.filter((c) => c.is_active || picked.some((r) => r.criterionScores[c.id] !== undefined));

  const columns: Column[] = [
    { header: "Rank", width: 7 },
    { header: "Register No", width: 16 },
    { header: "Name", width: 26 },
    { header: "Gender", width: 9 },
    { header: "Department", width: 14 },
    { header: "Section", width: 9 },
    { header: "Email", width: 30 },
    { header: "Phone", width: 15 },
    { header: "Problem Statement", width: 50, wrap: true },
    { header: "Domains", width: 24, wrap: true },
    ...scored.map((c) => ({ header: `${c.name} (/${c.max_marks})`, width: Math.max(12, c.name.length + 7) })),
    { header: "Total", width: 9 },
    { header: "Max", width: 7 },
    { header: "Percentage", width: 11 },
    { header: "Status", width: 12 },
    { header: "Evaluator", width: 20 },
    { header: "Remarks", width: 40, wrap: true },
    { header: "Submitted At", width: 20 },
  ];
  const data = picked.map((r) => {
    const d = details.get(r.studentId);
    return [
      r.rank,
      r.registerNumber,
      r.name,
      d?.gender ?? "",
      r.department ?? "",
      d?.section ?? "",
      d?.email ?? "",
      d?.phone ?? "",
      d?.problem_statement ?? "",
      r.domains ?? "",
      ...scored.map((c) => r.criterionScores[c.id] ?? ""),
      r.total,
      r.maxTotal,
      Math.round(r.percentage * 100) / 100,
      DECISION_LABELS[decision],
      r.evaluatorName ?? "",
      d?.remarks ?? "",
      d?.submitted_at ? formatDateTime(d.submitted_at) : "",
    ];
  });
  return { columns, data };
}

/** Active students without a submitted (COMPLETED) evaluation, including ones an evaluator has started. */
async function notEvaluatedSheet(department: string) {
  const list = await rows<{
    register_number: string;
    name: string;
    gender: string | null;
    department: string | null;
    section: string | null;
    email: string | null;
    phone: string | null;
    submission_status: string | null;
    problem_statement: string | null;
    ppt_url: string | null;
    evaluation_status: string | null;
    evaluator_name: string | null;
  }>(
    pool(),
    `SELECT s.register_number, s.name, s.gender, s.department, s.section, s.email, s.phone,
            i.submission_status, i.problem_statement, i.ppt_url, ev.status AS evaluation_status, e.name AS evaluator_name
       FROM students s
       LEFT JOIN ideas i ON i.student_id = s.id
       LEFT JOIN evaluations ev ON ev.student_id = s.id
       LEFT JOIN evaluators e ON e.id = ev.evaluator_id
      WHERE s.status = 'ACTIVE' AND (ev.id IS NULL OR ev.status <> 'COMPLETED')
        ${department ? "AND s.department = ?" : ""}
      ORDER BY s.department, s.register_number`,
    department ? [department] : [],
  );

  const columns: Column[] = [
    { header: "S.No", width: 6 },
    { header: "Register No", width: 16 },
    { header: "Name", width: 26 },
    { header: "Gender", width: 9 },
    { header: "Department", width: 14 },
    { header: "Section", width: 9 },
    { header: "Email", width: 30 },
    { header: "Phone", width: 15 },
    { header: "Idea Submitted", width: 15 },
    { header: "Problem Statement", width: 50, wrap: true },
    { header: "PPT / PDF Link", width: 36 },
    { header: "Progress", width: 14 },
    { header: "Claimed By", width: 20 },
  ];
  const submission: Record<string, string> = { SUBMITTED: "Yes", INCOMPLETE: "Incomplete" };
  const data = list.map((s, i) => [
    i + 1,
    s.register_number,
    s.name,
    s.gender ?? "",
    s.department ?? "",
    s.section ?? "",
    s.email ?? "",
    s.phone ?? "",
    s.submission_status ? (submission[s.submission_status] ?? s.submission_status) : "No",
    s.problem_statement ?? "",
    s.ppt_url ?? "",
    s.evaluation_status === "IN_PROGRESS" ? "In progress" : "Not started",
    s.evaluator_name ?? "",
  ]);
  return { columns, data };
}
