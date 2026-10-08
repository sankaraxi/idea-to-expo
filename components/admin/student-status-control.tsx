"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { selectClass } from "@/components/shared/ui-bits";
import { setStudentStatus } from "@/lib/actions/admin";

export function StudentStatusControl({ id, status }: { id: string; status: string }) {
  const [pending, start] = useTransition();
  return (
    <select
      className={selectClass}
      defaultValue={status}
      disabled={pending}
      aria-label="Student status"
      onChange={(e) => {
        const next = e.target.value;
        if (next !== "ACTIVE" && !window.confirm(`Mark this student as ${next.toLowerCase()}? They will be excluded from allocation and results.`)) {
          e.target.value = status;
          return;
        }
        start(async () => {
          const res = await setStudentStatus(id, next);
          if (res.ok) toast.success("Student status updated.");
          else toast.error(res.message);
        });
      }}
    >
      <option value="ACTIVE">Active</option>
      <option value="WITHDRAWN">Withdrawn</option>
      <option value="DISQUALIFIED">Disqualified</option>
    </select>
  );
}
