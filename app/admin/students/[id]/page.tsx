import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { EvaluationAdminActions } from "@/components/admin/evaluation-admin-actions";
import { StudentStatusControl } from "@/components/admin/student-status-control";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmissionDetails } from "@/components/shared/submission-details";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getStudentDetail } from "@/lib/data/admin";
import { formatDateTime } from "@/lib/format";
import { uuidSchema } from "@/lib/validation/schemas";

export const metadata: Metadata = { title: "Student" };

const MATCH_LABEL = {
  REGISTER_NUMBER: "Matched by register number",
  EMAIL: "Matched by email (register number on the form differed)",
  CREATED: "Not in the student CSV — created from the form response",
} as const;

export default async function StudentDetailPage({ params }: PageProps<"/admin/students/[id]">) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const detail = await getStudentDetail(id);
  if (!detail) notFound();
  const { student, idea, evaluation, criteria } = detail;

  const info = [
    ["Register number", student.register_number],
    ["Gender", student.gender],
    ["Department", student.department],
    ["Section", student.section],
    ["Email", student.email],
    ["Phone", student.phone],
    ["Source", student.source],
    ["Form submitted", formatDateTime(student.form_submitted_at)],
    ["Form link", idea ? MATCH_LABEL[idea.matched_by] : "—"],
    ["Response sheet row", idea?.response_row ?? "—"],
  ] as const;

  return (
    <div className="space-y-5">
      <Link href="/admin/students" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" /> Students
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{student.name}</h1>
        <span className="font-mono text-sm text-muted-foreground">{student.register_number}</span>
        <div className="ml-auto">
          <StudentStatusControl id={student.id} status={student.status} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <SubmissionDetails idea={idea} />
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Evaluation</CardTitle>
              {evaluation && (
                <CardAction>
                  <StatusBadge status={evaluation.status} />
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {!evaluation ? (
                <p className="text-muted-foreground">Not evaluated yet.</p>
              ) : (
                <>
                  <p>
                    By <span className="font-medium">{evaluation.evaluator_name}</span>
                    <span className="text-muted-foreground"> · {formatDateTime(evaluation.submitted_at ?? evaluation.updated_at)}</span>
                  </p>
                  <ul className="divide-y rounded-lg border">
                    {criteria.map((c) => (
                      <li key={c.id} className="flex justify-between px-3 py-1.5">
                        <span className={c.is_active ? "" : "text-muted-foreground"}>{c.name}</span>
                        <span className="tabular-nums">
                          {evaluation.scores[c.id] ?? "–"}
                          <span className="text-muted-foreground">/{c.max_marks}</span>
                        </span>
                      </li>
                    ))}
                    <li className="flex justify-between bg-muted px-3 py-1.5 font-semibold">
                      <span>Total</span>
                      <span className="tabular-nums">
                        {evaluation.total_score ?? "–"}/{evaluation.max_total ?? "–"}
                      </span>
                    </li>
                  </ul>
                  {evaluation.domains && <p>Domains: {evaluation.domains}</p>}
                  {evaluation.remarks && <p className="whitespace-pre-wrap text-muted-foreground">{evaluation.remarks}</p>}
                  <EvaluationAdminActions
                    evaluationId={evaluation.evaluation_id}
                    status={evaluation.status}
                    label={`${student.name} · ${evaluation.evaluator_name}`}
                  />
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Student</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
                {info.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="break-all">{v || "—"}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
