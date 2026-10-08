"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2, Search } from "lucide-react";
import { ClaimBadge } from "@/components/evaluator/claim-badge";
import { StatusBadge } from "@/components/shared/status-badge";
import { Input } from "@/components/ui/input";
import { searchStudents } from "@/lib/actions/evaluation";
import { cn } from "@/lib/utils";
import type { SearchResultRow } from "@/types/database";

/**
 * Live search by register number, name or email. ↑/↓ to move, Enter to open.
 * An exact register-number match is listed first, so typing the full number
 * and pressing Enter opens that student directly.
 */
export function StudentSearch({ autoFocus = false, initialQuery = "" }: { autoFocus?: boolean; initialQuery?: string }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResultRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [pending, start] = useTransition();
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const id = ++seq.current;
    const timer = window.setTimeout(() => {
      start(async () => {
        const res = await searchStudents(q).catch(() => null);
        if (id !== seq.current) return; // a newer search superseded this one
        if (!res) return setError("Could not reach the server.");
        if (!res.ok) return setError(res.message);
        setError(null);
        setResults(res.data);
        setCursor(0);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const visible = query.trim().length >= 2 ? results : null;
  const open = (r: SearchResultRow) => router.push(`/evaluator/students/${r.student_id}`);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (!visible?.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, visible.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              open(visible[cursor] ?? visible[0]);
            }
          }}
          placeholder="Search by register number, name or email…"
          className="h-12 pl-10 text-base"
          aria-label="Search students"
          autoComplete="off"
        />
        {pending && <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {query.trim().length > 0 && query.trim().length < 2 && (
        <p className="text-sm text-muted-foreground">Type at least 2 characters.</p>
      )}
      {visible && visible.length === 0 && !pending && (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No students found.</p>
      )}
      {visible && visible.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-lg border bg-card" role="listbox" aria-label="Search results">
          {visible.map((r, i) => (
            <li key={r.student_id} role="option" aria-selected={i === cursor}>
              <Link
                href={`/evaluator/students/${r.student_id}`}
                onMouseEnter={() => setCursor(i)}
                className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm", i === cursor ? "bg-accent" : "hover:bg-muted")}
              >
                <span className="font-mono text-xs">{r.register_number}</span>
                <span className="font-medium">{r.name}</span>
                <span className="text-muted-foreground">
                  {[r.department, r.section && `Sec ${r.section}`].filter(Boolean).join(" · ")}
                </span>
                <span className="hidden truncate text-xs text-muted-foreground md:inline">{r.email}</span>
                <span className="ml-auto flex items-center gap-2">
                  {r.submission_status !== "SUBMITTED" && <StatusBadge status={r.submission_status} />}
                  <ClaimBadge status={r.claim_status} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
