import type { Metadata } from "next";
import { PageHeader, ProgressBar } from "@/components/shared/ui-bits";
import { Card, CardContent } from "@/components/ui/card";
import { requireEvaluatorPage } from "@/lib/auth/session";
import { getMyAssignments, progressOf } from "@/lib/data/evaluator";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Profile" };

export default async function ProfilePage() {
  const user = await requireEvaluatorPage();
  const supabase = await createClient();
  const [{ data: me }, rows] = await Promise.all([
    supabase.from("evaluators").select("name, email, employee_id, department, status").eq("id", user.evaluatorId).single(),
    getMyAssignments(),
  ]);
  const progress = progressOf(rows);

  const fields = [
    ["Name", me?.name],
    ["Email", me?.email],
    ["Employee ID", me?.employee_id],
    ["Department", me?.department],
    ["Account status", me?.status],
  ] as const;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Profile" description="Contact the event admin to change your details or password." />
      <Card>
        <CardContent className="space-y-5">
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
            {fields.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium">{value || "—"}</dd>
              </div>
            ))}
          </dl>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>Completed {progress.completed} of {progress.assigned}</span>
              <span className="tabular-nums text-muted-foreground">{progress.percent}%</span>
            </div>
            <ProgressBar value={progress.percent} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
