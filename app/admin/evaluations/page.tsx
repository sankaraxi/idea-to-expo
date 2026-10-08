import type { Metadata } from "next";
import Link from "next/link";
import { EvaluationAdminActions } from "@/components/admin/evaluation-admin-actions";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { StatusBadge } from "@/components/shared/status-badge";
import { PageHeader, Pagination, StatCard, selectClass } from "@/components/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  getDashboardStats,
  getDepartments,
  getDomains,
  getEvaluatorOptions,
  listEvaluations,
  type EvaluationFilters,
} from "@/lib/data/admin";
import { formatDateTime, pageParam, stringParam } from "@/lib/format";

export const metadata: Metadata = { title: "Evaluations" };
const PAGE_SIZE = 50;

export default async function EvaluationsPage({ searchParams }: PageProps<"/admin/evaluations">) {
  const sp = await searchParams;
  const status = stringParam(sp.status);
  const filters: EvaluationFilters = {
    evaluator: stringParam(sp.evaluator),
    department: stringParam(sp.department),
    domain: stringParam(sp.domain),
    q: stringParam(sp.q),
    status: (["IN_PROGRESS", "COMPLETED"].includes(status) ? status : "") as EvaluationFilters["status"],
    page: pageParam(sp.page),
  };
  const [{ rows, total }, stats, evaluators, departments, domains] = await Promise.all([
    listEvaluations(filters, PAGE_SIZE),
    getDashboardStats(),
    getEvaluatorOptions(),
    getDepartments(),
    getDomains(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title="Evaluations" description="Every claimed student and their evaluation." actions={<AutoRefresh />} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Evaluated" value={stats.completed_evaluations} tone="success" />
        <StatCard label="In progress (drafts)" value={stats.in_progress_evaluations} tone="warning" />
        <StatCard label="Not evaluated" value={stats.not_evaluated} />
        <StatCard label="Average score" value={stats.average_percentage === null ? "—" : `${stats.average_percentage}%`} />
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
        <select name="domain" defaultValue={filters.domain} className={selectClass} aria-label="Domain">
          <option value="">All domains</option>
          {domains.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={filters.status} className={selectClass} aria-label="Status">
          <option value="">All statuses</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="COMPLETED">Evaluated</option>
        </select>
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
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="hidden lg:table-cell">Domains</TableHead>
              <TableHead className="hidden xl:table-cell">Remarks</TableHead>
              <TableHead className="hidden md:table-cell">Updated</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  No evaluations match these filters.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.evaluation_id}>
                <TableCell>
                  <Link href={`/admin/students/${r.student_id}`} className="font-medium hover:underline">
                    {r.student_name}
                  </Link>
                  <div className="font-mono text-xs text-muted-foreground">{r.register_number}</div>
                </TableCell>
                <TableCell className="hidden md:table-cell">{r.department ?? "—"}</TableCell>
                <TableCell>{r.evaluator_name}</TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {r.status === "COMPLETED" ? (
                    <>
                      {r.total_score}
                      <span className="text-xs font-normal text-muted-foreground">/{r.max_total}</span>
                    </>
                  ) : (
                    "–"
                  )}
                </TableCell>
                <TableCell className="hidden text-sm lg:table-cell">{r.domains ?? "—"}</TableCell>
                <TableCell className="hidden max-w-60 truncate text-sm text-muted-foreground xl:table-cell" title={r.remarks ?? undefined}>
                  {r.status === "COMPLETED" ? (r.remarks ?? "") : ""}
                </TableCell>
                <TableCell className="hidden text-sm md:table-cell">{formatDateTime(r.updated_at)}</TableCell>
                <TableCell>
                  <EvaluationAdminActions evaluationId={r.evaluation_id} status={r.status} label={`${r.student_name} · ${r.evaluator_name}`} />
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
