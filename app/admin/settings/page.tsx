import type { Metadata } from "next";
import { EventControl } from "@/components/admin/event-control";
import { EvaluationSettingsForm, FormMappingForm, SheetColumnsForm } from "@/components/admin/settings-forms";
import { PageHeader } from "@/components/shared/ui-bits";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCriteria, getFullSettings } from "@/lib/data/admin";
import { resolveMapping } from "@/lib/forms/mapping";
import { readResponseHeaders } from "@/lib/forms/service";
import { tieBreakerOptions } from "@/lib/results/ranking";
import { resolveWritebackSettings } from "@/lib/sheets/writeback";

export const metadata: Metadata = { title: "Settings" };

async function loadHeaders(): Promise<{ headers: string[] | null; error: string | null }> {
  try {
    const headers = await readResponseHeaders();
    return headers
      ? { headers, error: null }
      : { headers: null, error: "GOOGLE_FORM_RESPONSE_SHEET_ID is not configured — type the column headers manually." };
  } catch (e) {
    console.error("[settings] read response headers", e);
    return {
      headers: null,
      error: "Could not read the problem statement sheet. Share it with the service account as Editor, then reload.",
    };
  }
}

export default async function SettingsPage() {
  const [settings, criteria, sheet] = await Promise.all([getFullSettings(), getCriteria(), loadHeaders()]);

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
          <CardDescription>Criteria and domains are managed on the Criteria &amp; Domains page.</CardDescription>
        </CardHeader>
        <CardContent>
          <EvaluationSettingsForm
            allowResubmission={settings.allow_resubmission}
            tieBreakers={settings.tie_breakers}
            options={tieBreakerOptions(criteria.filter((c) => c.is_active))}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Problem statement sheet — score columns</CardTitle>
        </CardHeader>
        <CardContent>
          <SheetColumnsForm
            headers={sheet.headers}
            headerError={sheet.error}
            criteria={criteria}
            writeback={resolveWritebackSettings(settings.sheet_writeback)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Problem statement form — field mapping</CardTitle>
        </CardHeader>
        <CardContent>
          <FormMappingForm mapping={resolveMapping(settings.form_field_mapping)} />
        </CardContent>
      </Card>
    </div>
  );
}
