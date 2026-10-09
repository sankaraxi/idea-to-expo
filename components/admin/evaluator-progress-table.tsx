import { StatusBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { EvaluatorProgressRow } from "@/types/database";

/** Evaluators can take any number of students, so progress is shown as plain counts. */
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
          <TableHead className="text-right">Total taken</TableHead>
          <TableHead className="text-right">Avg score %</TableHead>
          {actions && <TableHead className="text-right">Actions</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={actions ? 6 : 5} className="py-6 text-center text-muted-foreground">
              No evaluators yet.
            </TableCell>
          </TableRow>
        )}
        {rows.map((r) => (
          <TableRow key={r.evaluator_id}>
            <TableCell>
              <div className="flex items-center gap-2">
                <span className="font-medium">{r.name}</span>
                {r.status === "DISABLED" && <StatusBadge status="DISABLED" />}
              </div>
              <div className="text-xs text-muted-foreground">{r.email}</div>
            </TableCell>
            <TableCell className="text-right font-semibold tabular-nums">{Number(r.completed_count)}</TableCell>
            <TableCell className="text-right tabular-nums">{Number(r.in_progress_count)}</TableCell>
            <TableCell className="text-right tabular-nums">{Number(r.claimed_count)}</TableCell>
            <TableCell className="text-right tabular-nums">{r.average_percentage ?? "—"}</TableCell>
            {actions && <TableCell className="text-right">{actions(r)}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
