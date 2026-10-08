import { cn } from "@/lib/utils";
import type { ClaimStatus } from "@/types/database";

const STYLES: Record<ClaimStatus, { label: string; className: string }> = {
  AVAILABLE: { label: "Available", className: "bg-primary/10 text-primary" },
  MINE_IN_PROGRESS: { label: "Your draft", className: "bg-warning/15 text-[oklch(0.5_0.12_70)]" },
  MINE_COMPLETED: { label: "Evaluated by you", className: "bg-success/10 text-success" },
  TAKEN: { label: "Taken by another evaluator", className: "bg-muted text-muted-foreground" },
};

export function ClaimBadge({ status, className }: { status: ClaimStatus; className?: string }) {
  const s = STYLES[status];
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap", s.className, className)}>
      {s.label}
    </span>
  );
}
