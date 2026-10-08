import type { Metadata } from "next";
import { AllocationPanel } from "@/components/admin/allocation-panel";
import { StatusBadge } from "@/components/shared/status-badge";
import { PageHeader } from "@/components/shared/ui-bits";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getAllocationOverview } from "@/lib/data/admin";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Allocation" };

export default async function AllocationPage() {
  const overview = await getAllocationOverview();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Allocation"
        description="Randomly and evenly distribute students to active evaluators."
      />
      <AllocationPanel
        activeStudents={overview.activeStudents}
        evaluatorCaps={overview.evaluatorCaps}
        liveAssignments={overview.liveAssignments}
        defaults={{
          maxPerEvaluator: overview.settings.max_per_evaluator,
          evaluatorsPerStudent: overview.settings.evaluators_per_student,
        }}
      />
      <Card>
        <CardHeader>
          <CardTitle>Allocation history</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Students</TableHead>
                <TableHead className="text-right">Evaluators</TableHead>
                <TableHead className="text-right">Assignments</TableHead>
                <TableHead className="text-right">Replaced</TableHead>
                <TableHead className="text-right">Max / per student</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.batches.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                    No allocations yet.
                  </TableCell>
                </TableRow>
              )}
              {overview.batches.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>{formatDateTime(b.created_at)}</TableCell>
                  <TableCell>{b.allocation_type.replace("_", " ").toLowerCase()}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.student_count}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.evaluator_count}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.assignment_count}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.replaced_count}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {b.max_per_evaluator} / {b.evaluators_per_student}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={b.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
