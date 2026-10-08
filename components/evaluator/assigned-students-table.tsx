"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownUp, Search } from "lucide-react";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState, selectClass } from "@/components/shared/ui-bits";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { MyAssignmentRow } from "@/types/database";

type StatusFilter = "ALL" | "PENDING" | "IN_PROGRESS" | "COMPLETED" | "NOT_COMPLETED";
type SortKey = "register_number" | "student_name" | "department" | "status" | "score";

const PAGE_SIZE = 25;
const STATUS_ORDER = { IN_PROGRESS: 0, PENDING: 1, COMPLETED: 2, REPLACED: 3 } as const;

/**
 * Evaluator's assigned list. ~50 rows, so search / filter / sort / paging
 * happen instantly in the browser. Keyboard: "/" search, j/k or ↑/↓ move,
 * Enter opens the selected student.
 */
export function AssignedStudentsTable({ rows }: { rows: MyAssignmentRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "register_number", dir: 1 });
  const [page, setPage] = useState(1);
  const [cursor, setCursor] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (status === "NOT_COMPLETED" && r.assignment_status === "COMPLETED") return false;
      if (status !== "ALL" && status !== "NOT_COMPLETED" && r.assignment_status !== status) return false;
      if (!q) return true;
      return [r.register_number, r.student_name, r.department ?? "", r.section ?? ""].some((v) =>
        v.toLowerCase().includes(q),
      );
    });
    const value = (r: MyAssignmentRow): string | number => {
      switch (sort.key) {
        case "status":
          return STATUS_ORDER[r.assignment_status];
        case "score":
          return r.evaluation_status === "COMPLETED" ? (r.score ?? -1) : -1;
        default:
          return (r[sort.key] ?? "").toString().toLowerCase();
      }
    };
    return list.sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return (x < y ? -1 : x > y ? 1 : a.register_number.localeCompare(b.register_number)) * sort.dir;
    });
  }, [rows, query, status, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const activeCursor = Math.min(cursor, Math.max(0, visible.length - 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing) {
        if (e.key === "Escape") (target as HTMLInputElement).blur();
        if (e.key === "Enter" && target === searchRef.current && visible[0]) {
          router.push(`/evaluator/evaluate/${visible[0].assignment_id}`);
        }
        return;
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, visible.length - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === "Enter" && visible[activeCursor]) {
        router.push(`/evaluator/evaluate/${visible[activeCursor].assignment_id}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, activeCursor, router]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));

  const header = (key: SortKey, label: string, className?: string) => (
    <TableHead className={className}>
      <button type="button" onClick={() => toggleSort(key)} className="inline-flex items-center gap-1 hover:text-foreground">
        {label}
        <ArrowDownUp className={cn("size-3", sort.key === key ? "opacity-100" : "opacity-30")} />
      </button>
    </TableHead>
  );

  if (rows.length === 0) {
    return <EmptyState title="No students assigned yet">Students appear here once the admin confirms the allocation.</EmptyState>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
              setCursor(0);
            }}
            placeholder="Search register no, name…  ( / )"
            className="pl-8"
            aria-label="Search assigned students"
          />
        </div>
        <select
          className={selectClass}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as StatusFilter);
            setPage(1);
            setCursor(0);
          }}
          aria-label="Filter by status"
        >
          <option value="ALL">All statuses</option>
          <option value="NOT_COMPLETED">Not completed</option>
          <option value="PENDING">Pending</option>
          <option value="IN_PROGRESS">In progress</option>
          <option value="COMPLETED">Completed</option>
        </select>
        <span className="ml-auto hidden text-xs text-muted-foreground md:inline">
          Keys: <kbd>/</kbd> search · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open
        </span>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              {header("register_number", "Register No")}
              {header("student_name", "Student")}
              {header("department", "Department", "hidden md:table-cell")}
              {header("status", "Status")}
              {header("score", "Score", "text-right")}
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No students match your filters.
                </TableCell>
              </TableRow>
            )}
            {visible.map((r, i) => (
              <TableRow
                key={r.assignment_id}
                data-state={i === activeCursor ? "selected" : undefined}
                className="cursor-pointer"
                onClick={() => router.push(`/evaluator/evaluate/${r.assignment_id}`)}
              >
                <TableCell className="font-mono text-xs">{r.register_number}</TableCell>
                <TableCell className="font-medium">{r.student_name}</TableCell>
                <TableCell className="hidden md:table-cell">{r.department ?? "—"}</TableCell>
                <TableCell>
                  <StatusBadge status={r.assignment_status} />
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {r.evaluation_status === "COMPLETED" ? r.score : "–"}
                </TableCell>
                <TableCell className="text-right">
                  <Link
                    href={`/evaluator/evaluate/${r.assignment_id}`}
                    onClick={(e) => e.stopPropagation()}
                    className={buttonVariants({
                      size: "sm",
                      variant: r.assignment_status === "COMPLETED" ? "outline" : "default",
                    })}
                  >
                    {r.assignment_status === "COMPLETED" ? "View" : r.assignment_status === "IN_PROGRESS" ? "Continue" : "Evaluate"}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <button type="button" className={buttonVariants({ variant: "outline", size: "sm" })} disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>
            Prev
          </button>
          <span className="text-muted-foreground">
            Page {currentPage} / {pages}
          </span>
          <button type="button" className={buttonVariants({ variant: "outline", size: "sm" })} disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
