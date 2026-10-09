import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { StudentImportControls } from "@/components/admin/student-import";
import { StatusBadge } from "@/components/shared/status-badge";
import { PageHeader, Pagination, selectClass } from "@/components/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDepartments, listStudents, type StudentFilters } from "@/lib/data/admin";
import { pageParam, stringParam } from "@/lib/format";
import { safeExternalUrl } from "@/lib/ppt";

export const metadata: Metadata = { title: "Students" };
const PAGE_SIZE = 50;

function pick<T extends string>(value: string, allowed: readonly T[]): T | "" {
  return (allowed as readonly string[]).includes(value) ? (value as T) : "";
}

export default async function StudentsPage({ searchParams }: PageProps<"/admin/students">) {
  const sp = await searchParams;
  const filters: StudentFilters = {
    q: stringParam(sp.q),
    department: stringParam(sp.department),
    evaluation: pick(stringParam(sp.evaluation), ["NOT_EVALUATED", "IN_PROGRESS", "COMPLETED"] as const),
    submission: pick(stringParam(sp.submission), ["SUBMITTED", "INCOMPLETE", "MISSING"] as const),
    matched: pick(stringParam(sp.matched), ["CREATED", "EMAIL"] as const),
    status: pick(stringParam(sp.status), ["ACTIVE", "WITHDRAWN", "DISQUALIFIED"] as const),
    page: pageParam(sp.page),
  };
  const [{ rows, total }, departments] = await Promise.all([listStudents(filters, PAGE_SIZE), getDepartments()]);

  return (
    <div>
      <PageHeader
        title="Students"
        description="Imported from CSV (master data) and linked to problem statement submissions by register number or email."
        actions={<StudentImportControls />}
      />

      <form className="mb-3 flex flex-wrap items-center gap-2" role="search">
        <Input name="q" defaultValue={filters.q} placeholder="Register no, name or email" className="w-56" />
        <select name="department" defaultValue={filters.department} className={selectClass} aria-label="Department">
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select name="evaluation" defaultValue={filters.evaluation} className={selectClass} aria-label="Evaluation status">
          <option value="">Any evaluation status</option>
          <option value="NOT_EVALUATED">Not evaluated</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="COMPLETED">Evaluated</option>
        </select>
        <select name="submission" defaultValue={filters.submission} className={selectClass} aria-label="Submission status">
          <option value="">Any submission</option>
          <option value="SUBMITTED">Submitted</option>
          <option value="INCOMPLETE">Incomplete</option>
          <option value="MISSING">No submission</option>
        </select>
        <select name="matched" defaultValue={filters.matched} className={selectClass} aria-label="Form match">
          <option value="">Any form match</option>
          <option value="CREATED">Not in CSV (created from form)</option>
          <option value="EMAIL">Matched by email</option>
        </select>
        <select name="status" defaultValue={filters.status} className={selectClass} aria-label="Student status">
          <option value="">Any student status</option>
          <option value="ACTIVE">Active</option>
          <option value="WITHDRAWN">Withdrawn</option>
          <option value="DISQUALIFIED">Disqualified</option>
        </select>
        <Button type="submit" variant="secondary">Apply</Button>
        <Link href="/admin/students" className="text-sm text-muted-foreground hover:text-foreground">
          Reset
        </Link>
      </form>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Register No</TableHead>
              <TableHead>Student</TableHead>
              <TableHead className="hidden md:table-cell">Department</TableHead>
              <TableHead>Submission</TableHead>
              <TableHead>Evaluation</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden lg:table-cell">Evaluator</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">PPT</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  No students match these filters.
                </TableCell>
              </TableRow>
            )}
            {rows.map((s) => {
              const ppt = safeExternalUrl(s.ppt_url);
              return (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/admin/students/${s.id}`} className="hover:underline">
                      {s.register_number}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/admin/students/${s.id}`} className="font-medium hover:underline">
                      {s.name}
                    </Link>
                    {s.status !== "ACTIVE" && <StatusBadge status={s.status} className="ml-2" />}
                    <div className="text-xs text-muted-foreground">{s.email ?? "—"}</div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {s.department ?? "—"}
                    {s.section && <span className="text-muted-foreground"> · {s.section}</span>}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={s.submission_status} />
                    {s.matched_by === "CREATED" && <StatusBadge status="NOT_IN_CSV" className="ml-1" />}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={s.evaluation_status} />
                  </TableCell>
                  <TableCell>{s.decision ? <StatusBadge status={s.decision} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="hidden text-sm lg:table-cell">{s.evaluator_name ?? "—"}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {s.evaluation_status === "COMPLETED" ? (
                      <>
                        {s.total_score}
                        <span className="text-xs font-normal text-muted-foreground">/{s.max_total}</span>
                      </>
                    ) : (
                      "–"
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {ppt ? (
                      <a href={ppt} target="_blank" rel="noopener noreferrer" className="inline-flex text-primary" aria-label="Open PPT">
                        <ExternalLink className="size-4" />
                      </a>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <Pagination page={filters.page} pageSize={PAGE_SIZE} total={total} searchParams={sp} basePath="/admin/students" />
    </div>
  );
}
