import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import { SyncControls } from "@/components/admin/sync-controls";
import { StudentImportControls } from "@/components/admin/student-import";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { StatusBadge } from "@/components/shared/status-badge";
import { PageHeader, StatCard } from "@/components/shared/ui-bits";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getSyncOverview } from "@/lib/data/admin";
import { googleConfig, secret } from "@/lib/env";
import { formatDateTime } from "@/lib/format";

export const metadata: Metadata = { title: "Google Sheets Sync" };

export default async function SyncPage() {
  const overview = await getSyncOverview();
  const google = googleConfig();
  const sheetUrl = google?.sheetId ? `https://docs.google.com/spreadsheets/d/${google.sheetId}` : null;
  const responseUrl = google?.formResponseSheetId ? `https://docs.google.com/spreadsheets/d/${google.formResponseSheetId}` : null;
  const pending = overview.counts.PENDING + overview.counts.PROCESSING;

  const checks = [
    ["Service account (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY)", !!google],
    ["Problem statement sheet — ingest + score write-back (GOOGLE_FORM_RESPONSE_SHEET_ID)", !!google?.formResponseSheetId],
    ["Optional reporting sheet (GOOGLE_SHEET_ID)", !!google?.sheetId],
    ["Apps Script webhook secret (FORM_SYNC_SECRET)", !!secret("FORM_SYNC_SECRET")],
    ["Scheduler secret (CRON_SECRET)", !!secret("CRON_SECRET")],
  ] as const;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Google Sheets Sync"
        description="The database is the source of truth; Google Sheets is updated continuously from a retrying queue."
        actions={<AutoRefresh intervalMs={10_000} />}
      />

      {!google && (
        <Alert variant="destructive">
          <AlertTitle>Google Sheets is not configured</AlertTitle>
          <AlertDescription>Evaluations still work and are queued; they will sync once credentials are added.</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Pending" value={overview.counts.PENDING} />
        <StatCard label="Processing" value={overview.counts.PROCESSING} hint={overview.workerActive ? "worker running" : undefined} />
        <StatCard label="Synced" value={overview.counts.SUCCESS} tone="success" />
        <StatCard label="Failed" value={overview.counts.FAILED} tone={overview.counts.FAILED ? "danger" : undefined} />
        <StatCard label="Last synced" value={<span className="text-base">{formatDateTime(overview.lastSuccessAt)}</span>} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Google Sheets</CardTitle>
          <CardDescription>
            Scores and totals are written into the problem statement sheet (columns mapped in Settings). The optional reporting
            sheet gets Students, Evaluators, Evaluations, Results and Dashboard tabs.
          </CardDescription>
          <CardAction className="flex flex-col items-end gap-1">
            {responseUrl && (
              <a href={responseUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                Problem statement sheet <ExternalLink className="size-3.5" />
              </a>
            )}
            {sheetUrl && (
              <a href={sheetUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                Reporting sheet <ExternalLink className="size-3.5" />
              </a>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          <SyncControls configured={!!google} pending={pending} />
          <ul className="grid gap-1 text-sm md:grid-cols-2">
            {checks.map(([label, okay]) => (
              <li key={label} className="flex items-center gap-2">
                <span className={okay ? "text-success" : "text-destructive"}>{okay ? "✓" : "✗"}</span>
                <span className="text-muted-foreground">{label}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {overview.failed.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">Failed jobs</CardTitle>
            <CardDescription>Gave up after repeated retries. Fix the cause, then “Retry failed”.</CardDescription>
          </CardHeader>
          <CardContent>
            <JobTable jobs={overview.failed} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Problem statement synchronisation</CardTitle>
          <CardDescription>Submissions arrive via the Apps Script webhook on each form submit, or can be pulled on demand.</CardDescription>
          <CardAction className="flex gap-2">
            <StudentImportControls showCsv={false} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead className="text-right">New</TableHead>
                <TableHead className="text-right">Updated</TableHead>
                <TableHead className="text-right">Skipped</TableHead>
                <TableHead className="hidden lg:table-cell">First error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.formRuns.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">No form syncs yet.</TableCell>
                </TableRow>
              )}
              {overview.formRuns.map((r) => {
                const errors = Array.isArray(r.errors) ? (r.errors as { error?: string }[]) : [];
                return (
                  <TableRow key={r.id}>
                    <TableCell>{formatDateTime(r.created_at)}</TableCell>
                    <TableCell>{r.source.replace("_", " ").toLowerCase()}</TableCell>
                    <TableCell><StatusBadge status={r.status} /></TableCell>
                    <TableCell className="text-right tabular-nums">{r.received}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.inserted}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.updated}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.skipped}</TableCell>
                    <TableCell className="hidden max-w-72 truncate text-xs text-muted-foreground lg:table-cell">{errors[0]?.error ?? ""}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent queue activity</CardTitle>
        </CardHeader>
        <CardContent>
          <JobTable jobs={overview.recent} />
        </CardContent>
      </Card>
    </div>
  );
}

function JobTable({ jobs }: { jobs: Awaited<ReturnType<typeof getSyncOverview>>["recent"] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Created</TableHead>
          <TableHead>Entity</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Attempts</TableHead>
          <TableHead className="hidden md:table-cell">Next retry / processed</TableHead>
          <TableHead className="hidden lg:table-cell">Last error</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.length === 0 && (
          <TableRow>
            <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">Queue is empty.</TableCell>
          </TableRow>
        )}
        {jobs.map((j) => (
          <TableRow key={j.id}>
            <TableCell>{formatDateTime(j.created_at)}</TableCell>
            <TableCell>
              {j.entity_type.toLowerCase()} <span className="font-mono text-xs text-muted-foreground">{j.entity_id.slice(0, 8)}</span>
            </TableCell>
            <TableCell><StatusBadge status={j.status} /></TableCell>
            <TableCell className="text-right tabular-nums">{j.attempts}</TableCell>
            <TableCell className="hidden md:table-cell">
              {formatDateTime(j.status === "PENDING" ? j.next_retry_at : j.processed_at)}
            </TableCell>
            <TableCell className="hidden max-w-80 truncate text-xs text-destructive lg:table-cell" title={j.last_error ?? undefined}>
              {j.last_error ?? ""}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
