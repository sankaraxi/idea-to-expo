import { StatusBadge } from "@/components/shared/status-badge";
import { ProgressBar } from "@/components/shared/ui-bits";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EvaluatorProgressRow } from "@/types/database";

/** Progress = submitted evaluations against the evaluator's limit. */
export function EvaluatorProgressTable({
  rows,
  actions,
}: {
  rows: EvaluatorProgressRow[];
  actions?: (row: EvaluatorProgressRow) => React.ReactNode;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Evaluator</TableHead>
          <TableHead className="text-right">Evaluated</TableHead>
          <TableHead className="text-right">Drafts</TableHead>
          <TableHead className="text-right">Limit</TableHead>
          <TableHead className="hidden text-right md:table-cell">Avg %</TableHead>
          <TableHead className="w-40">Progress</TableHead>
          {actions && <TableHead className="text-right">Actions</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={actions ? 7 : 6} className="py-6 text-center text-muted-foreground">
              No evaluators yet.
            </TableCell>
          </TableRow>
        )}
        {rows.map((r) => {
          const completed = Number(r.completed_count);
          const pct = r.evaluation_cap ? Math.round((completed / r.evaluation_cap) * 100) : 0;
          return (
            <TableRow key={r.evaluator_id}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  {r.status === "DISABLED" && <StatusBadge status="DISABLED" />}
                </div>
                <div className="text-xs text-muted-foreground">{r.email}</div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{completed}</TableCell>
              <TableCell className="text-right tabular-nums">{Number(r.in_progress_count)}</TableCell>
              <TableCell className="text-right tabular-nums">{r.evaluation_cap}</TableCell>
              <TableCell className="hidden text-right tabular-nums md:table-cell">{r.average_percentage ?? "—"}</TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <ProgressBar value={pct} className="h-2" />
                  <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
                </div>
              </TableCell>
              {actions && <TableCell className="text-right">{actions(r)}</TableCell>}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
