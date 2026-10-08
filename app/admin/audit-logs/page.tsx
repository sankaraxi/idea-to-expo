import type { Metadata } from "next";
import { PageHeader, Pagination, selectClass } from "@/components/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listAuditLogs } from "@/lib/data/admin";
import { formatDateTime, pageParam, stringParam } from "@/lib/format";

export const metadata: Metadata = { title: "Audit Logs" };
const PAGE_SIZE = 50;

const ACTIONS = [
  "ADMIN_LOGIN",
  "EVALUATOR_LOGIN",
  "STUDENT_IMPORT",
  "GOOGLE_FORM_SYNC",
  "STUDENT_STATUS_CHANGED",
  "EVALUATOR_CREATED",
  "EVALUATOR_UPDATED",
  "EVALUATOR_DISABLED",
  "EVALUATOR_ENABLED",
  "EVALUATOR_PASSWORD_RESET",
  "CRITERION_CREATED",
  "CRITERION_UPDATED",
  "CRITERION_DELETED",
  "DOMAIN_CREATED",
  "DOMAIN_UPDATED",
  "DOMAIN_DELETED",
  "EVALUATION_SUBMITTED",
  "EVALUATION_UPDATED",
  "EVALUATION_REOPENED",
  "EVALUATION_RELEASED",
  "EVENT_STATUS_CHANGED",
  "SETTINGS_UPDATED",
  "FORM_MAPPING_UPDATED",
  "SHEET_COLUMNS_UPDATED",
  "TIE_BREAK_PRIORITY_SET",
  "SHEET_FULL_RESYNC",
  "GOOGLE_SHEET_SYNC_FAILURE",
];

export default async function AuditLogsPage({ searchParams }: PageProps<"/admin/audit-logs">) {
  const sp = await searchParams;
  const action = ACTIONS.includes(stringParam(sp.action)) ? stringParam(sp.action) : "";
  const page = pageParam(sp.page);
  const { rows, total, profiles } = await listAuditLogs({ action, page }, PAGE_SIZE);
  const who = new Map(profiles.map((p) => [p.id, p]));

  return (
    <div>
      <PageHeader title="Audit Logs" description="Every important operation, newest first." />
      <form className="mb-3 flex items-center gap-2">
        <select name="action" defaultValue={action} className={selectClass} aria-label="Action">
          <option value="">All actions</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a.replace(/_/g, " ").toLowerCase()}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary">Apply</Button>
      </form>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Action</TableHead>
              <TableHead className="hidden md:table-cell">Entity</TableHead>
              <TableHead className="hidden lg:table-cell">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No entries.</TableCell>
              </TableRow>
            )}
            {rows.map((r) => {
              const user = r.user_id ? who.get(r.user_id) : null;
              return (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(r.created_at)}</TableCell>
                  <TableCell>
                    {user ? (
                      <>
                        <div className="font-medium">{user.full_name ?? user.email}</div>
                        <div className="text-xs text-muted-foreground">{user.role.toLowerCase()}</div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">system</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.action}</TableCell>
                  <TableCell className="hidden text-xs md:table-cell">
                    {r.entity_type} <span className="text-muted-foreground">{r.entity_id?.slice(0, 8)}</span>
                  </TableCell>
                  <TableCell className="hidden max-w-md truncate font-mono text-xs text-muted-foreground lg:table-cell" title={JSON.stringify(r.metadata)}>
                    {JSON.stringify(r.metadata)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} searchParams={sp} basePath="/admin/audit-logs" />
    </div>
  );
}
