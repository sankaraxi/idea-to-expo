import type { Metadata } from "next";
import { EventControl } from "@/components/admin/event-control";
import { EvaluationSettingsForm, FormMappingForm } from "@/components/admin/settings-forms";
import { PageHeader } from "@/components/shared/ui-bits";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getFullSettings } from "@/lib/data/admin";
import { resolveMapping } from "@/lib/forms/mapping";
import { TIE_BREAKERS } from "@/lib/results/ranking";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const settings = await getFullSettings();
  const options = Object.entries(TIE_BREAKERS).map(([id, t]) => ({ id, label: t.label }));

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader title="Settings" />
      <Card>
        <CardHeader>
          <CardTitle>Event status</CardTitle>
        </CardHeader>
        <CardContent>
          <EventControl status={settings.event_status} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Evaluation &amp; ranking</CardTitle>
          <CardDescription>
            Allocation limits (max per evaluator, evaluators per student) are set on the Allocation page. Current:{" "}
            {settings.max_per_evaluator} max · {settings.evaluators_per_student} per student.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EvaluationSettingsForm allowResubmission={settings.allow_resubmission} tieBreakers={settings.tie_breakers} options={options} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Google Form field mapping</CardTitle>
        </CardHeader>
        <CardContent>
          <FormMappingForm mapping={resolveMapping(settings.form_field_mapping)} />
        </CardContent>
      </Card>
    </div>
  );
}
