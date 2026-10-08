import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { EVENT_STATUS_HELP } from "@/components/shared/event-status-badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState, PageHeader, ProgressBar, StatCard, formatDateTime } from "@/components/shared/ui-bits";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireEvaluatorPage } from "@/lib/auth/session";
import { getMyAssignments, nextPendingAssignment, progressOf } from "@/lib/data/evaluator";
import { getSettings } from "@/lib/data/settings";

export const metadata: Metadata = { title: "Dashboard" };

function greeting() {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date()),
  );
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

export default async function EvaluatorDashboard() {
  const [user, rows, settings] = await Promise.all([requireEvaluatorPage(), getMyAssignments(), getSettings()]);
  const progress = progressOf(rows);
  const next = nextPendingAssignment(rows);
  const recent = rows
    .filter((r) => r.assignment_status === "COMPLETED")
    .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""))
    .slice(0, 5);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title={`${greeting()}, ${user.name}`} description="Your evaluation progress for Idea to Expo." />

      {settings.event_status !== "LIVE" && (
        <Alert>
          <AlertDescription>{EVENT_STATUS_HELP[settings.event_status]}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Assigned" value={progress.assigned} />
        <StatCard label="Completed" value={progress.completed} tone="success" />
        <StatCard label="Pending" value={progress.pending} tone={progress.pending ? "warning" : undefined} />
      </div>

      <Card>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Progress</span>
            <span className="tabular-nums text-muted-foreground">{progress.percent}%</span>
          </div>
          <ProgressBar value={progress.percent} />
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            {next ? (
              <p className="text-sm text-muted-foreground">
                Next up: <span className="font-medium text-foreground">{next.student_name}</span> ({next.register_number})
              </p>
            ) : progress.assigned > 0 ? (
              <p className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="size-4" /> All assigned evaluations are complete. Thank you!
              </p>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Link href="/evaluator/students" className={buttonVariants({ variant: "outline" })}>
                View all students
              </Link>
              {next && (
                <Link href={`/evaluator/evaluate/${next.assignment_id}`} className={buttonVariants()}>
                  {next.assignment_status === "IN_PROGRESS" ? "Continue" : "Start evaluating"} <ArrowRight />
                </Link>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {progress.assigned === 0 ? (
        <EmptyState title="No students assigned yet">
          Students appear here once the admin confirms the allocation.
        </EmptyState>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Recently submitted</CardTitle>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing submitted yet.</p>
            ) : (
              <ul className="divide-y">
                {recent.map((r) => (
                  <li key={r.assignment_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <Link href={`/evaluator/evaluate/${r.assignment_id}`} className="min-w-0 hover:underline">
                      <span className="font-medium">{r.student_name}</span>{" "}
                      <span className="text-muted-foreground">{r.register_number}</span>
                    </Link>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="hidden text-xs text-muted-foreground sm:inline">{formatDateTime(r.completed_at)}</span>
                      <StatusBadge status="COMPLETED" />
                      <span className="w-6 text-right font-semibold tabular-nums">{r.score}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
