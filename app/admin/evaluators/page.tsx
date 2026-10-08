import type { Metadata } from "next";
import { CreateEvaluatorButton, EvaluatorRowActions } from "@/components/admin/evaluator-dialogs";
import { EvaluatorProgressTable } from "@/components/admin/evaluator-progress-table";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { PageHeader, StatCard } from "@/components/shared/ui-bits";
import { Card, CardContent } from "@/components/ui/card";
import { getEvaluatorProgress } from "@/lib/data/admin";

export const metadata: Metadata = { title: "Evaluators" };

export default async function EvaluatorsPage() {
  const rows = await getEvaluatorProgress();
  const active = rows.filter((r) => r.status === "ACTIVE");
  const assigned = rows.reduce((n, r) => n + Number(r.assigned_count), 0);
  const completed = rows.reduce((n, r) => n + Number(r.completed_count), 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Evaluators"
        description="Add, edit and enable/disable evaluator logins, and monitor their progress."
        actions={
          <>
            <AutoRefresh intervalMs={20_000} />
            <CreateEvaluatorButton />
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Active evaluators" value={active.length} hint={`${rows.length - active.length} disabled`} />
        <StatCard label="Assigned" value={assigned} />
        <StatCard label="Completed" value={completed} tone="success" />
        <StatCard label="Pending" value={assigned - completed} tone="warning" />
      </div>
      <Card>
        <CardContent>
          <EvaluatorProgressTable rows={rows} actions={(row) => <EvaluatorRowActions row={row} />} />
        </CardContent>
      </Card>
    </div>
  );
}
