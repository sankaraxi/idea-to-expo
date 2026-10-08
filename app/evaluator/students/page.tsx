import type { Metadata } from "next";
import { AssignedStudentsTable } from "@/components/evaluator/assigned-students-table";
import { PageHeader } from "@/components/shared/ui-bits";
import { getMyAssignments, progressOf } from "@/lib/data/evaluator";

export const metadata: Metadata = { title: "My Students" };

export default async function MyStudentsPage() {
  const rows = await getMyAssignments();
  const progress = progressOf(rows);
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="My Students"
        description={`${progress.completed} of ${progress.assigned} completed · ${progress.pending} pending`}
      />
      <AssignedStudentsTable rows={rows} />
    </div>
  );
}
