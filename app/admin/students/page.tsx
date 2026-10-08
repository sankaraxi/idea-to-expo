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

export default async function StudentsPage({ searchParams }: PageProps<"/admin/students">) {
  const sp = await searchParams;
  const filters: StudentFilters = {
    q: stringParam(sp.q),
    department: stringParam(sp.department),
    evaluation: (["UNASSIGNED", "PENDING", "COMPLETED"].includes(stringParam(sp.evaluation)) ? stringParam(sp.evaluation) : "") as StudentFilters["evaluation"],
    submission: (["SUBMITTED", "INCOMPLETE", "MISSING"].includes(stringParam(sp.submission)) ? stringParam(sp.submission) : "") as StudentFilters["submission"],
    status: ["ACTIVE", "WITHDRAWN", "DISQUALIFIED"].includes(stringParam(sp.status)) ? stringParam(sp.status) : "",
    page: pageParam(sp.page),
  };
  const [{ rows, total }, departments] = await Promise.all([listStudents(filters, PAGE_SIZE), getDepartments()]);

  return (
    <div>
      <PageHeader
        title="Students"
        description="Google Form submissions synchronised by register number."
        actions={<StudentImportControls />}
      />

      <form className="mb-3 flex flex-wrap items-center gap-2" role="search">
        <Input name="q" defaultValue={filters.q} placeholder="Register no or name" className="w-56" />
        <select name="department" defaultValue={filters.department} className={selectClass} aria-label="Department">
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select name="evaluation" defaultValue={filters.evaluation} className={selectClass} aria-label="Evaluation status">
          <option value="">Any evaluation status</option>
          <option value="UNASSIGNED">Unassigned</option>
          <option value="PENDING">Assigned · pending</option>
          <option value="COMPLETED">Fully evaluated</option>
        </select>
        <select name="submission" defaultValue={filters.submission} className={selectClass} aria-label="Submission status">
          <option value="">Any submission</option>
          <option value="SUBMITTED">Submitted</option>
          <option value="INCOMPLETE">Incomplete</option>
          <option value="MISSING">Missing</option>
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
              <TableHead className="hidden lg:table-cell">Evaluator(s)</TableHead>
              <TableHead>Evaluation</TableHead>
              <TableHead className="text-right">Score</TableHead>
              <TableHead className="text-right">PPT</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
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
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{s.department ?? "—"}</TableCell>
                  <TableCell>
                    <StatusBadge status={s.submission_status} />
                  </TableCell>
                  <TableCell className="hidden max-w-48 truncate text-sm lg:table-cell">{s.evaluator_names ?? "—"}</TableCell>
                  <TableCell>
                    <StatusBadge status={s.evaluation_state} />
                    {s.assigned_count > 0 && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        {s.completed_count}/{s.assigned_count}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{s.average_score ?? "–"}</TableCell>
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
