"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { setTieBreakPriority } from "@/lib/actions/admin";

export function TieBreakInput({ studentId, value }: { studentId: string; value: number | null }) {
  const [draft, setDraft] = useState(value?.toString() ?? "");
  const [pending, start] = useTransition();

  const commit = () => {
    const next = draft.trim() === "" ? null : Number(draft);
    if (next === value) return;
    if (next !== null && (!Number.isInteger(next) || next < 1)) {
      toast.error("Priority must be a positive whole number (1 = highest).");
      return;
    }
    start(async () => {
      const result = await setTieBreakPriority(studentId, next);
      if (result.ok) toast.success("Tie-break priority saved.");
      else toast.error(result.message);
    });
  };

  return (
    <Input
      type="number"
      min={1}
      value={draft}
      disabled={pending}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      className="h-7 w-20"
      aria-label="Admin tie-break priority"
      placeholder="—"
    />
  );
}
