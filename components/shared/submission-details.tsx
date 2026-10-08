import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PptViewer } from "@/components/shared/ppt-viewer";
import { pptEmbedUrl, safeExternalUrl } from "@/lib/ppt";
import type { IdeaRow } from "@/types/database";

type Idea = Pick<
  IdeaRow,
  "title" | "problem_statement" | "idea_description" | "team_details" | "ppt_url" | "other_details" | "submission_status"
>;

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</h3>
      <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap">{value || <span className="text-muted-foreground">Not provided</span>}</p>
    </div>
  );
}

export function SubmissionDetails({ idea }: { idea: Idea | null }) {
  if (!idea) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
          <AlertTriangle className="size-5 text-warning" />
          This student has no idea submission on record.
        </CardContent>
      </Card>
    );
  }

  const other =
    idea.other_details && typeof idea.other_details === "object" && !Array.isArray(idea.other_details)
      ? Object.entries(idea.other_details as Record<string, unknown>)
      : [];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>{idea.title || "Idea submission"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Problem statement" value={idea.problem_statement} />
          <Field label="Idea description" value={idea.idea_description} />
          {idea.team_details && <Field label="Team details" value={idea.team_details} />}
          {other.length > 0 && (
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Other details</h3>
              <dl className="mt-2 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
                {other.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="break-words whitespace-pre-wrap">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </CardContent>
      </Card>
      <PptViewer url={safeExternalUrl(idea.ppt_url)} embedUrl={pptEmbedUrl(idea.ppt_url)} />
    </div>
  );
}
