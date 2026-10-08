import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { EvaluationForm } from "@/components/evaluator/evaluation-form";
import { SubmissionDetails } from "@/components/shared/submission-details";
import { StatusBadge } from "@/components/shared/status-badge";
import { getEvaluationContext, getMyAssignments, nextPendingAssignment } from "@/lib/data/evaluator";
import { getSettings } from "@/lib/data/settings";
import { uuidSchema } from "@/lib/validation/schemas";

export const metadata: Metadata = { title: "Evaluate" };

export default async function EvaluatePage({ params }: PageProps<"/evaluator/evaluate/[assignmentId]">) {
  const { assignmentId } = await params;
  if (!uuidSchema.safeParse(assignmentId).success) notFound();

  const [context, rows, settings] = await Promise.all([
    getEvaluationContext(assignmentId),
    getMyAssignments(),
    getSettings(),
  ]);
  // RLS returns nothing for assignments that are not the caller's.
  if (!context) notFound();

  const { assignment, idea, evaluation } = context;
  const next = nextPendingAssignment(rows, assignmentId);
  const position = rows.findIndex((r) => r.assignment_id === assignmentId) + 1;

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link href="/evaluator/students" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> My Students
        </Link>
        <span className="text-xs text-muted-foreground">
          Student {position} of {rows.length}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{assignment.student_name}</h1>
        <span className="font-mono text-sm text-muted-foreground">{assignment.register_number}</span>
        <StatusBadge status={assignment.assignment_status} />
        <span className="text-sm text-muted-foreground">
          {[assignment.department, assignment.section && `Section ${assignment.section}`, assignment.year && `Year ${assignment.year}`]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <SubmissionDetails idea={idea} />
        <div className="lg:sticky lg:top-20 lg:self-start">
          <EvaluationForm
            assignmentId={assignmentId}
            studentName={assignment.student_name}
            eventStatus={settings.event_status}
            allowResubmission={settings.allow_resubmission}
            initial={
              evaluation
                ? {
                    score: evaluation.score,
                    remarks: evaluation.remarks ?? "",
                    status: evaluation.status,
                    updatedAt: evaluation.updated_at,
                    submittedAt: evaluation.submitted_at,
                  }
                : null
            }
            nextHref={next ? `/evaluator/evaluate/${next.assignment_id}` : null}
            nextLabel={next ? `${next.student_name} (${next.register_number})` : null}
          />
        </div>
      </div>
    </div>
  );
}
