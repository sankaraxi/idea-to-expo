/**
 * The evaluator's overall verdict for a student ("Status" in the portal).
 * Stored in the database only — it is intentionally never written to Google Sheets.
 */
export const DECISIONS = ["SELECTED", "WAITLISTED", "REJECTED"] as const;
export type Decision = (typeof DECISIONS)[number];

export const DECISION_LABELS: Record<Decision, string> = {
  SELECTED: "Selected",
  WAITLISTED: "Waitlisted",
  REJECTED: "Rejected",
};

export const isDecision = (value: unknown): value is Decision => typeof value === "string" && (DECISIONS as readonly string[]).includes(value);

/** Tailwind classes for a chosen / unchosen option (uses the theme's success / warning / destructive colors). */
export const DECISION_STYLES: Record<Decision, { selected: string; idle: string; dot: string }> = {
  SELECTED: {
    selected: "border-success bg-success text-white shadow-sm",
    idle: "hover:border-success/60 hover:bg-success/10",
    dot: "bg-success",
  },
  WAITLISTED: {
    selected: "border-warning bg-warning text-[oklch(0.25_0.05_70)] shadow-sm",
    idle: "hover:border-warning/70 hover:bg-warning/15",
    dot: "bg-warning",
  },
  REJECTED: {
    selected: "border-destructive bg-destructive text-white shadow-sm",
    idle: "hover:border-destructive/60 hover:bg-destructive/10",
    dot: "bg-destructive",
  },
};
