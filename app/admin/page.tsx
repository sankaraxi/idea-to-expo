import type { Metadata } from "next";
import Link from "next/link";
import { DepartmentProgressChart, ScoreDistributionChart } from "@/components/admin/dashboard-charts";
import { EventControl } from "@/components/admin/event-control";
import { EvaluatorProgressTable } from "@/components/admin/evaluator-progress-table";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { PageHeader, ProgressBar, StatCard, formatDateTime } from "@/components/shared/ui-bits";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDashboardStats, getEvaluatorProgress } from "@/lib/data/admin";
import { sheetsConfigured } from "@/lib/sheets/worker";

export const metadata: Metadata = { title: "Dashboard" };

export default async function AdminDashboard() {
  const [stats, evaluators] = await Promise.all([getDashboardStats(), getEvaluatorProgress()]);
  const total = Number(stats.total_assignments);
  const completed = Number(stats.completed_evaluations);
  const completion = total ? (completed / total) * 100 : 0;

  return (
    <div className="space-y-5">
      <PageHeader title="Dashboard" description="Live overview of the ideathon evaluation." actions={<AutoRefresh />} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Students" value={stats.total_students} />
        <StatCard label="Ideas submitted" value={stats.ideas_submitted} hint={stats.ideas_incomplete ? `${stats.ideas_incomplete} incomplete` : undefined} />
        <StatCard label="Evaluators" value={stats.total_evaluators} />
        <StatCard label="Assigned students" value={stats.assigned_students} hint={`${total} assignments`} />
        <StatCard label="Completed" value={completed} tone="success" />
        <StatCard label="Pending" value={Number(stats.pending_evaluations) + Number(stats.in_progress_evaluations)} hint={`${stats.in_progress_evaluations} in progress`} tone="warning" />
        <StatCard label="Average score" value={stats.average_score ?? "—"} />
        <StatCard label="Completion" value={`${completion.toFixed(1)}%`} />
      </div>

      <Card>
        <CardContent className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="font-medium">Overall progress</span>
            <span className="tabular-nums text-muted-foreground">
              {completed} / {total}
            </span>
          </div>
          <ProgressBar value={completion} className="h-3" />
        </CardContent>
      </Card>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Event control</CardTitle>
          </CardHeader>
          <CardContent>
            <EventControl status={stats.event_status} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Google Sheets</CardTitle>
            <CardAction>
              <Link href="/admin/sync" className="text-sm text-primary hover:underline">
                Details
              </Link>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {!sheetsConfigured() ? (
              <p className="text-destructive">Not configured — set GOOGLE_* environment variables.</p>
            ) : (
              <>
                <p>
                  Queue: <span className="font-medium">{stats.sync_pending}</span> pending
                  {stats.sync_failed > 0 && <span className="text-destructive"> · {stats.sync_failed} failed</span>}
                </p>
                <p className="text-muted-foreground">Last synced: {formatDateTime(stats.last_sync_at)}</p>
              </>
            )}
            <p className="text-muted-foreground">Last form sync: {formatDateTime(stats.last_form_sync_at)}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Score distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <ScoreDistributionChart distribution={stats.score_distribution} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Progress by department</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.department_progress.length ? (
              <DepartmentProgressChart departments={stats.department_progress} />
            ) : (
              <p className="text-sm text-muted-foreground">No assignments yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Evaluator progress</CardTitle>
          <CardAction>
            <Link href="/admin/evaluators" className="text-sm text-primary hover:underline">
              Manage
            </Link>
          </CardAction>
        </CardHeader>
        <CardContent>
          <EvaluatorProgressTable rows={evaluators} />
        </CardContent>
      </Card>
    </div>
  );
}
