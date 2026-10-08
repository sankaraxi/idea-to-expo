import type { Metadata } from "next";
import Link from "next/link";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState, PageHeader } from "@/components/shared/ui-bits";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireEvaluatorPage } from "@/lib/auth/session";
import { getMyEvaluations, getMyQuota } from "@/lib/data/evaluator";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "My Evaluations" };

export default async function MyEvaluationsPage() {
  const user = await requireEvaluatorPage();
  const [rows, quota] = await Promise.all([getMyEvaluations(), getMyQuota(user.evaluatorId)]);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="My Evaluations"
        description={`${quota.completed} submitted · ${quota.inProgress} draft(s) · ${quota.remaining} of ${quota.cap} remaining`}
      />
      {rows.length === 0 ? (
        <EmptyState title="No evaluations yet">
          <Link href="/evaluator/search" className="text-primary hover:underline">
            Find a student
          </Link>{" "}
          to start evaluating.
        </EmptyState>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Register No</TableHead>
                <TableHead>Student</TableHead>
                <TableHead className="hidden md:table-cell">Department</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="hidden md:table-cell">Updated</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.evaluation_id}>
                  <TableCell className="font-mono text-xs">{r.register_number}</TableCell>
                  <TableCell className="font-medium">{r.student_name}</TableCell>
                  <TableCell className="hidden md:table-cell">{r.department ?? "—"}</TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {r.total_score ?? "–"}
                    <span className="text-xs font-normal text-muted-foreground">/{r.max_total ?? "–"}</span>
                  </TableCell>
                  <TableCell className="hidden text-sm md:table-cell">{formatDateTime(r.updated_at)}</TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/evaluator/students/${r.student_id}`}
                      className={buttonVariants({ size: "sm", variant: r.status === "COMPLETED" ? "outline" : "default" })}
                    >
                      {r.status === "COMPLETED" ? "View" : "Continue"}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
