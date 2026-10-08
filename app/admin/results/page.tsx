import type { Metadata } from "next";
import Link from "next/link";
import { TieBreakInput } from "@/components/admin/tie-break-input";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { PageHeader, selectClass } from "@/components/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDepartments, getResults } from "@/lib/data/admin";
import { stringParam } from "@/lib/format";
import { TIE_BREAKERS, isTieBreakerId } from "@/lib/results/ranking";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Results" };

export default async function ResultsPage({ searchParams }: PageProps<"/admin/results">) {
  const sp = await searchParams;
  const department = stringParam(sp.department);
  const [{ ranked, settings }, departments] = await Promise.all([getResults(), getDepartments()]);
  const rows = department ? ranked.filter((r) => r.department === department) : ranked;
  const usesAdminPriority = settings.tie_breakers.includes("ADMIN_PRIORITY_ASC");
  const rules = settings.tie_breakers.filter(isTieBreakerId).map((id) => TIE_BREAKERS[id].label);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Results"
        description={
          <>
            Final score = average of all completed evaluator scores. Ties broken by:{" "}
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
        <span className="text-sm text-muted-foreground">{rows.length} ranked students</span>
      </form>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Rank</TableHead>
              <TableHead>Register No</TableHead>
              <TableHead>Student</TableHead>
              <TableHead className="hidden md:table-cell">Department</TableHead>
              <TableHead className="text-right">Score</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Scores</TableHead>
              <TableHead className="text-right">Evaluations</TableHead>
              {usesAdminPriority && <TableHead className="text-right">Tie-break</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  No completed evaluations yet.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.studentId} className={cn(r.rank <= 3 && "bg-primary/[0.03]")}>
                <TableCell className="font-semibold tabular-nums">
                  {r.rank}
                  {r.tied && <span className="ml-1 text-xs font-normal text-warning" title="Tied">=</span>}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.registerNumber}</TableCell>
                <TableCell>
                  <Link href={`/admin/students/${r.studentId}`} className="font-medium hover:underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell className="hidden md:table-cell">{r.department ?? "—"}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{r.finalScore.toFixed(2)}</TableCell>
                <TableCell className="hidden text-right text-xs text-muted-foreground tabular-nums sm:table-cell">{r.scores.join(", ")}</TableCell>
                <TableCell className="text-right tabular-nums">{r.evaluationCount}</TableCell>
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
