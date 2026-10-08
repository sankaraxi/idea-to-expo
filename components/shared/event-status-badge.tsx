import { cn } from "@/lib/utils";
import type { EventStatus } from "@/types/database";

const STYLES: Record<EventStatus, { label: string; className: string; dot: string }> = {
  NOT_STARTED: { label: "Not started", className: "bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
  LIVE: { label: "Live", className: "bg-success/10 text-success", dot: "bg-success animate-pulse" },
  PAUSED: { label: "Paused", className: "bg-warning/15 text-[oklch(0.5_0.12_70)]", dot: "bg-warning" },
  CLOSED: { label: "Closed", className: "bg-destructive/10 text-destructive", dot: "bg-destructive" },
};

export function EventStatusBadge({ status, className }: { status: EventStatus; className?: string }) {
  const style = STYLES[status];
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", style.className, className)}
      title="Event status"
    >
      <span className={cn("size-1.5 rounded-full", style.dot)} />
      Event {style.label}
    </span>
  );
}

export const EVENT_STATUS_HELP: Record<EventStatus, string> = {
  NOT_STARTED: "Evaluators can browse their students but cannot save or submit.",
  LIVE: "Evaluators can evaluate and submit.",
  PAUSED: "Submission is temporarily disabled. Drafts are still saved.",
  CLOSED: "No new evaluations can be submitted.",
};
