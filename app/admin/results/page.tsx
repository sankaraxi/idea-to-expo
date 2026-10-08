import type { Metadata } from "next";
import Link from "next/link";
import { TieBreakInput } from "@/components/admin/tie-break-input";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { PageHeader, selectClass } from "@/components/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDepartments, getResults } from "@/lib/data/admin";
import { stringParam } from "@/lib/format";
import { tieBreakerOptions } from "@/lib/results/ranking";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Results" };

export default async function ResultsPage({ searchParams }: PageProps<"/admin/results">) {
  const sp = await searchParams;
  const department = stringParam(sp.department);
  const [{ ranked, tieBreakers, criteria }, departments] = await Promise.all([getResults(), getDepartments()]);
  const rows = department ? ranked.filter((r) => r.department === department) : ranked;
  const labels = new Map(tieBreakerOptions(criteria).map((o) => [o.id, o.label]));
  const rules = tieBreakers.map((id) => labels.get(id)).filter(Boolean);
  const usesAdminPriority = tieBreakers.includes("ADMIN_PRIORITY_ASC");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Results"
        description={
          <>
            Ranked by total score (as a percentage of the maximum). Ties broken by:{" "}
            {rules.length ? rules.join(" → ") : "none (tied students share a rank)"}.{" "}
            <Link href="/admin/settings" className="text-primary hover:underline">
              Change
            </Link>
          </>
        }
        actions={<AutoRefresh intervalMs={20_000} />}
      />

      <form className="flex items-center gap-2">
        <select name="department" defaultValue={department} className={selectClass} aria-label="Department">
          <option value="">All departments (overall rank)</option>
          {departments.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <Button type="submit" variant="secondary">Apply</Button>
        <span className="text-sm text-muted-foreground">{rows.length} evaluated students</span>
      </form>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Rank</TableHead>
              <TableHead>Register No</TableHead>
              <TableHead>Student</TableHead>
              <TableHead className="hidden md:table-cell">Department</TableHead>
              {criteria.map((c) => (
                <TableHead key={c.id} className="hidden text-right xl:table-cell" title={`max ${c.max_marks}`}>
                  {c.name}
                </TableHead>
              ))}
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">%</TableHead>
              <TableHead className="hidden lg:table-cell">Domains</TableHead>
              <TableHead className="hidden lg:table-cell">Evaluator</TableHead>
              {usesAdminPriority && <TableHead className="text-right">Tie-break</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9 + criteria.length} className="py-8 text-center text-muted-foreground">
                  No submitted evaluations yet.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.studentId} className={cn(r.rank <= 3 && "bg-primary/[0.03]")}>
                <TableCell className="font-semibold tabular-nums">
                  {r.rank}
                  {r.tied && (
                    <span className="ml-1 text-xs font-normal text-warning" title="Tied">
                      =
                    </span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.registerNumber}</TableCell>
                <TableCell>
                  <Link href={`/admin/students/${r.studentId}`} className="font-medium hover:underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell className="hidden md:table-cell">{r.department ?? "—"}</TableCell>
                {criteria.map((c) => (
                  <TableCell key={c.id} className="hidden text-right tabular-nums xl:table-cell">
                    {r.criterionScores[c.id] ?? "–"}
                  </TableCell>
                ))}
                <TableCell className="text-right font-semibold tabular-nums">
                  {r.total}
                  <span className="text-xs font-normal text-muted-foreground">/{r.maxTotal}</span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.percentage}</TableCell>
                <TableCell className="hidden text-sm lg:table-cell">{r.domains ?? "—"}</TableCell>
                <TableCell className="hidden text-sm lg:table-cell">{r.evaluatorName ?? "—"}</TableCell>
                {usesAdminPriority && (
                  <TableCell className="flex justify-end">
                    <TieBreakInput studentId={r.studentId} value={r.tieBreakPriority ?? null} />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
