import type { Metadata } from "next";
import Link from "next/link";
import { ReopenEvaluationButton } from "@/components/admin/reopen-evaluation";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { StatusBadge } from "@/components/shared/status-badge";
import { PageHeader, Pagination, StatCard, selectClass } from "@/components/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDashboardStats, getDepartments, getEvaluatorOptions, listEvaluations, type EvaluationFilters } from "@/lib/data/admin";
import { formatDateTime, pageParam, stringParam } from "@/lib/format";

export const metadata: Metadata = { title: "Evaluations" };
const PAGE_SIZE = 50;

function scoreParam(v: string | string[] | undefined) {
  const n = Number(stringParam(v));
  return stringParam(v) !== "" && Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
}

export default async function EvaluationsPage({ searchParams }: PageProps<"/admin/evaluations">) {
  const sp = await searchParams;
  const status = stringParam(sp.status);
  const filters: EvaluationFilters = {
    evaluator: stringParam(sp.evaluator),
    department: stringParam(sp.department),
    q: stringParam(sp.q),
    status: (["PENDING", "IN_PROGRESS", "COMPLETED"].includes(status) ? status : "") as EvaluationFilters["status"],
    minScore: scoreParam(sp.min),
    maxScore: scoreParam(sp.max),
    page: pageParam(sp.page),
  };
  const [{ rows, total }, stats, evaluators, departments] = await Promise.all([
    listEvaluations(filters, PAGE_SIZE),
    getDashboardStats(),
    getEvaluatorOptions(),
    getDepartments(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title="Evaluations" description="Monitor every assignment and its evaluation." actions={<AutoRefresh />} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total evaluations" value={stats.total_assignments} />
        <StatCard label="Completed" value={stats.completed_evaluations} tone="success" />
        <StatCard label="In progress" value={stats.in_progress_evaluations} tone="warning" />
        <StatCard label="Pending" value={stats.pending_evaluations} />
      </div>

      <form className="flex flex-wrap items-center gap-2" role="search">
        <Input name="q" defaultValue={filters.q} placeholder="Student register no / name" className="w-56" />
        <select name="evaluator" defaultValue={filters.evaluator} className={selectClass} aria-label="Evaluator">
          <option value="">All evaluators</option>
          {evaluators.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
              {e.status === "DISABLED" ? " (disabled)" : ""}
            </option>
          ))}
        </select>
        <select name="department" defaultValue={filters.department} className={selectClass} aria-label="Department">
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select name="status" defaultValue={filters.status} className={selectClass} aria-label="Status">
          <option value="">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="COMPLETED">Completed</option>
        </select>
        <Input name="min" type="number" min={1} max={10} defaultValue={filters.minScore ?? ""} placeholder="Min" className="w-20" aria-label="Minimum score" />
        <Input name="max" type="number" min={1} max={10} defaultValue={filters.maxScore ?? ""} placeholder="Max" className="w-20" aria-label="Maximum score" />
        <Button type="submit" variant="secondary">Apply</Button>
        <Link href="/admin/evaluations" className="text-sm text-muted-foreground hover:text-foreground">
          Reset
        </Link>
      </form>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Student</TableHead>
              <TableHead className="hidden md:table-cell">Department</TableHead>
              <TableHead>Evaluator</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Score</TableHead>
              <TableHead className="hidden lg:table-cell">Remarks</TableHead>
              <TableHead className="hidden md:table-cell">Submitted</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  No evaluations match these filters.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.assignment_id}>
                <TableCell>
                  <Link href={`/admin/students/${r.student_id}`} className="font-medium hover:underline">
                    {r.student_name}
                  </Link>
                  <div className="font-mono text-xs text-muted-foreground">{r.register_number}</div>
                </TableCell>
                <TableCell className="hidden md:table-cell">{r.department ?? "—"}</TableCell>
                <TableCell>{r.evaluator_name}</TableCell>
                <TableCell>
                  <StatusBadge status={r.assignment_status} />
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {r.evaluation_status === "COMPLETED" ? r.score : "–"}
                </TableCell>
                <TableCell className="hidden max-w-72 truncate text-sm text-muted-foreground lg:table-cell" title={r.remarks ?? undefined}>
                  {r.evaluation_status === "COMPLETED" ? (r.remarks ?? "") : ""}
                </TableCell>
                <TableCell className="hidden text-sm md:table-cell">{formatDateTime(r.submitted_at)}</TableCell>
                <TableCell className="text-right">
                  {r.evaluation_id && r.evaluation_status === "COMPLETED" && (
                    <ReopenEvaluationButton
                      evaluationId={r.evaluation_id}
                      label={`${r.student_name} · ${r.evaluator_name} · score ${r.score}`}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Pagination page={filters.page} pageSize={PAGE_SIZE} total={total} searchParams={sp} basePath="/admin/evaluations" />
    </div>
  );
}
