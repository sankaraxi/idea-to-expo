import type { Metadata } from "next";
import Link from "next/link";
import { EVENT_STATUS_HELP } from "@/components/shared/event-status-badge";
import { StudentSearch } from "@/components/evaluator/student-search";
import { StatusBadge } from "@/components/shared/status-badge";
import { PageHeader, ProgressBar, StatCard } from "@/components/shared/ui-bits";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireEvaluatorPage } from "@/lib/auth/session";
import { getMyEvaluations, getMyStats } from "@/lib/data/evaluator";
import { getSettings } from "@/lib/data/settings";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard" };

function greeting() {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date()),
  );
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

export default async function EvaluatorDashboard() {
  const user = await requireEvaluatorPage();
  const [rows, stats, settings] = await Promise.all([getMyEvaluations(user.evaluatorId), getMyStats(user.evaluatorId), getSettings()]);
  const drafts = rows.filter((r) => r.status === "IN_PROGRESS");
  const recent = rows.filter((r) => r.status === "COMPLETED").slice(0, 5);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title={`${greeting()}, ${user.name}`} description="Search for a student by register number to evaluate them." />

      {settings.event_status !== "LIVE" && (
        <Alert>
          <AlertDescription>{EVENT_STATUS_HELP[settings.event_status]}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent>
          <StudentSearch autoFocus />
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Evaluated by you" value={stats.completed} tone="success" />
        <StatCard label="Your drafts" value={stats.inProgress} tone={stats.inProgress ? "warning" : undefined} />
        <StatCard label="Students not yet taken" value={stats.unclaimedStudents} />
        <StatCard label="Event progress" value={`${stats.eventPercent}%`} hint={`${stats.eventCompleted} of ${stats.eventTotal} students`} />
      </div>

      <Card>
        <CardContent className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="font-medium">Whole event</span>
            <span className="tabular-nums text-muted-foreground">
              {stats.eventCompleted} / {stats.eventTotal}
            </span>
          </div>
          <ProgressBar value={stats.eventPercent} />
        </CardContent>
      </Card>

      {drafts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Continue your drafts</CardTitle>
          </CardHeader>
          <CardContent>
            <EvaluationList rows={drafts} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recently submitted</CardTitle>
          <CardAction>
            <Link href="/evaluator/evaluations" className="text-sm text-primary hover:underline">
              View all
            </Link>
          </CardAction>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? <p className="text-sm text-muted-foreground">Nothing submitted yet.</p> : <EvaluationList rows={recent} />}
        </CardContent>
      </Card>
    </div>
  );
}

function EvaluationList({ rows }: { rows: Awaited<ReturnType<typeof getMyEvaluations>> }) {
  return (
    <ul className="divide-y">
      {rows.map((r) => (
        <li key={r.evaluation_id} className="flex items-center justify-between gap-3 py-2 text-sm">
          <Link href={`/evaluator/students/${r.student_id}`} className="min-w-0 hover:underline">
            <span className="font-medium">{r.student_name}</span> <span className="text-muted-foreground">{r.register_number}</span>
          </Link>
          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline">{formatDateTime(r.updated_at)}</span>
            <StatusBadge status={r.status} />
            <span className="w-14 text-right font-semibold tabular-nums">
              {r.total_score ?? "–"}
              <span className="text-xs font-normal text-muted-foreground">/{r.max_total ?? "–"}</span>
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
