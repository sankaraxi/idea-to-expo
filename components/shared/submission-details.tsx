import { AlertTriangle } from "lucide-react";
import { PptViewer } from "@/components/shared/ppt-viewer";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { driveFileId } from "@/lib/drive/ppt-pdf";
import { pptEmbedUrl, safeExternalUrl } from "@/lib/ppt";
import type { Json } from "@/types/database";

interface Idea {
  problem_statement: string | null;
  abstract: string | null;
  ppt_url: string | null;
  other_details: Json;
  submission_status: "SUBMITTED" | "INCOMPLETE";
  submitted_at: string | null;
}

export function SubmissionDetails({ idea }: { idea: Idea | null }) {
  if (!idea) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
          <AlertTriangle className="size-5 text-warning" />
          No problem statement has been submitted by this student yet.
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
          <CardTitle>Problem statement</CardTitle>
          <CardAction className="flex items-center gap-2">
            {idea.submission_status !== "SUBMITTED" && <StatusBadge status={idea.submission_status} />}
            {idea.submitted_at && <span className="text-xs text-muted-foreground">{formatDateTime(idea.submitted_at)}</span>}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {idea.problem_statement || <span className="text-muted-foreground">No problem statement provided.</span>}
          </p>
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Abstract of the idea</h3>
            <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap">
              {idea.abstract || <span className="text-muted-foreground">No abstract provided.</span>}
            </p>
          </div>
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
      <PptViewer url={safeExternalUrl(idea.ppt_url)} embedUrl={driveFileId(idea.ppt_url ?? "") ? `/api/ppt?url=${encodeURIComponent(idea.ppt_url!)}` : pptEmbedUrl(idea.ppt_url)} />
    </div>
  );
}
