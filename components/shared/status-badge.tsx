import { cn } from "@/lib/utils";

const TONES = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/15 text-[oklch(0.5_0.12_70)]",
  danger: "bg-destructive/10 text-destructive",
} as const;

const STATUS_TONE: Record<string, keyof typeof TONES> = {
  PENDING: "neutral",
  IN_PROGRESS: "warning",
  COMPLETED: "success",
  REPLACED: "neutral",
  SUBMITTED: "success",
  INCOMPLETE: "warning",
  MISSING: "danger",
  ACTIVE: "success",
  DISABLED: "danger",
  WITHDRAWN: "neutral",
  DISQUALIFIED: "danger",
  CONFIRMED: "success",
  CANCELLED: "neutral",
  DRAFT: "neutral",
  PROCESSING: "info",
  SUCCESS: "success",
  FAILED: "danger",
  SUPERSEDED: "neutral",
  PARTIAL: "warning",
  UNASSIGNED: "danger",
  NOT_EVALUATED: "neutral",
  NOT_IN_CSV: "warning",
  SELECTED: "success",
  WAITLISTED: "warning",
  REJECTED: "danger",
  NOT_SET: "neutral",
};

const LABELS: Record<string, string> = {
  IN_PROGRESS: "In progress",
  UNASSIGNED: "Unassigned",
  NOT_EVALUATED: "Not evaluated",
  COMPLETED: "Evaluated",
  NOT_IN_CSV: "Not in CSV",
  MISSING: "No submission",
  NOT_SET: "Not set",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const label = LABELS[status] ?? status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONES[STATUS_TONE[status] ?? "neutral"],
        className,
      )}
    >
      {label}
    </span>
  );
}
