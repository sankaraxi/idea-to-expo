import { Download } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { kind: "selected", label: "Selected", tone: "border-success/40 text-success hover:bg-success/10" },
  { kind: "waitlisted", label: "Waitlisted", tone: "border-warning/50 text-warning hover:bg-warning/10" },
  { kind: "rejected", label: "Rejected", tone: "border-destructive/40 text-destructive hover:bg-destructive/10" },
  { kind: "not-evaluated", label: "Not evaluated", tone: "" },
] as const;

/** One .xlsx download per student group; `department` narrows every file to that department. */
export function ExportButtons({ department = "" }: { department?: string }) {
  const href = (kind: string) => `/api/admin/export?${new URLSearchParams(department ? { kind, department } : { kind })}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">Download Excel{department ? ` (${department})` : ""}:</span>
      {OPTIONS.map((o) => (
        <a key={o.kind} href={href(o.kind)} download className={cn(buttonVariants({ variant: "outline", size: "sm" }), o.tone)}>
          <Download />
          {o.label}
        </a>
      ))}
    </div>
  );
}
