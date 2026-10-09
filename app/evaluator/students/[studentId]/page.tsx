import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Mail } from "lucide-react";
import { ClaimBadge } from "@/components/evaluator/claim-badge";
import { EvaluationForm } from "@/components/evaluator/evaluation-form";
import { SubmissionDetails } from "@/components/shared/submission-details";
import { Card, CardContent } from "@/components/ui/card";
import { requireEvaluatorPage } from "@/lib/auth/session";
import { getActiveCriteria, getActiveDomains, getStudentForEvaluation } from "@/lib/data/evaluator";
import { getSettings } from "@/lib/data/settings";
import { uuidSchema } from "@/lib/validation/schemas";

export const metadata: Metadata = { title: "Student" };

export default async function EvaluatorStudentPage({ params }: PageProps<"/evaluator/students/[studentId]">) {
  const { studentId } = await params;
  if (!uuidSchema.safeParse(studentId).success) notFound();
  const user = await requireEvaluatorPage();

  const [detail, criteria, domains, settings] = await Promise.all([
    getStudentForEvaluation(user.evaluatorId, studentId),
    getActiveCriteria(),
    getActiveDomains(),
    getSettings(),
  ]);
  if (!detail) notFound();
  const { student, idea, claim_status: claim, evaluation } = detail;

  return (
    <div className="mx-auto max-w-7xl">
      <Link href="/evaluator/search" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" /> Find Student
      </Link>

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{student.name}</h1>
        <span className="font-mono text-sm text-muted-foreground">{student.register_number}</span>
        <ClaimBadge status={claim} />
        <span className="text-sm text-muted-foreground">
          {[student.department, student.section && `Section ${student.section}`].filter(Boolean).join(" · ")}
        </span>
        {student.email && (
          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            <Mail className="size-3.5" /> {student.email}
          </span>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        <SubmissionDetails idea={idea} />
        <div className="lg:sticky lg:top-20 lg:self-start">
          {claim === "TAKEN" ? (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground">
                This student is already being evaluated by another evaluator. Each student can be evaluated by only one
                evaluator.
              </CardContent>
            </Card>
          ) : (
            <EvaluationForm
              studentId={student.id}
              studentName={student.name}
              claimStatus={claim}
              criteria={criteria}
              domains={domains}
              eventStatus={settings.event_status}
              allowResubmission={settings.allow_resubmission}
              initial={
                evaluation
                  ? {
                      scores: evaluation.scores,
                      remarks: evaluation.remarks ?? "",
                      domainIds: evaluation.domain_ids,
                      status: evaluation.status,
                      updatedAt: evaluation.updated_at,
                    }
                  : null
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
