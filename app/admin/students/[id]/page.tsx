import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { StudentStatusControl } from "@/components/admin/student-status-control";
import { StatusBadge } from "@/components/shared/status-badge";
import { SubmissionDetails } from "@/components/shared/submission-details";
import { formatDateTime } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getStudentDetail } from "@/lib/data/admin";
import { uuidSchema } from "@/lib/validation/schemas";

export const metadata: Metadata = { title: "Student" };

export default async function StudentDetailPage({ params }: PageProps<"/admin/students/[id]">) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const detail = await getStudentDetail(id);
  if (!detail) notFound();
  const { student, idea, assignments } = detail;

  const info = [
    ["Register number", student.register_number],
    ["Department", student.department],
    ["Year", student.year],
    ["Section", student.section],
    ["Email", student.email],
    ["Phone", student.phone],
    ["Source", student.source],
    ["Form submitted", formatDateTime(student.form_submitted_at)],
    ["Last updated", formatDateTime(student.updated_at)],
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

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <SubmissionDetails idea={idea} />
        <div className="space-y-5">
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
          <Card>
            <CardHeader>
              <CardTitle>Evaluator assignments</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {assignments.length === 0 && <p className="text-sm text-muted-foreground">Not assigned yet.</p>}
              {assignments.map((a) => (
                <div key={a.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{a.evaluator?.name ?? "Unknown evaluator"}</span>
                    <StatusBadge status={a.status} />
                  </div>
                  <p className="text-xs text-muted-foreground">Assigned {formatDateTime(a.assigned_at)}</p>
                  {a.evaluation?.status === "COMPLETED" && (
                    <div className="mt-2 space-y-1">
                      <p>
                        Score: <span className="font-semibold">{a.evaluation.score}</span>
                        <span className="ml-2 text-xs text-muted-foreground">{formatDateTime(a.evaluation.submitted_at)}</span>
                      </p>
                      {a.evaluation.remarks && <p className="whitespace-pre-wrap text-muted-foreground">{a.evaluation.remarks}</p>}
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
