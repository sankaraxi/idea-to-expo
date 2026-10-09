import { isDecision, type Decision } from "@/lib/decision";

/**
 * Local draft recovery. Every change is mirrored to localStorage; the server
 * holds the debounced copy. On load we pick whichever is newer, so a
 * refresh, crash or network drop never loses an evaluator's work.
 */

export interface DraftValues {
  scores: Record<string, number>;
  remarks: string;
  domainIds: string[];
  decision: Decision | null;
}

export interface LocalDraft extends DraftValues {
  savedAt: number;
}

export interface ServerDraft extends DraftValues {
  status: "IN_PROGRESS" | "COMPLETED";
  updatedAt: string;
}

export const draftKey = (studentId: string) => `ite:draft:v3:${studentId}`;

export function parseLocalDraft(raw: string | null): LocalDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LocalDraft>;
    if (typeof value.savedAt !== "number" || typeof value.remarks !== "string") return null;
    const scores: Record<string, number> = {};
    if (value.scores && typeof value.scores === "object") {
      for (const [k, v] of Object.entries(value.scores)) {
        if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100) scores[k] = v;
      }
    }
    const domainIds = Array.isArray(value.domainIds) ? value.domainIds.filter((d): d is string => typeof d === "string") : [];
    return {
      scores,
      remarks: value.remarks.slice(0, 5000),
      domainIds,
      decision: isDecision(value.decision) ? value.decision : null,
      savedAt: value.savedAt,
    };
  } catch {
    return null;
  }
}

export function sameDraft(a: DraftValues, b: DraftValues) {
  const keys = new Set([...Object.keys(a.scores), ...Object.keys(b.scores)]);
  for (const k of keys) if (a.scores[k] !== b.scores[k]) return false;
  const da = [...a.domainIds].sort().join(",");
  const db = [...b.domainIds].sort().join(",");
  return a.remarks.trim() === b.remarks.trim() && da === db && a.decision === b.decision;
}

/** Keeps only criteria / domains that still exist (admin may have changed them). */
export function pruneDraft(values: DraftValues, criteria: { id: string; max_marks: number }[], domainIds: string[]): DraftValues {
  const scores: Record<string, number> = {};
  for (const c of criteria) {
    const v = values.scores[c.id];
    if (v !== undefined && v <= c.max_marks) scores[c.id] = v;
  }
  const allowed = new Set(domainIds);
  return { scores, remarks: values.remarks, decision: values.decision, domainIds: values.domainIds.filter((d) => allowed.has(d)) };
}

export function chooseInitialDraft(
  server: ServerDraft | null,
  local: LocalDraft | null,
): DraftValues & { source: "server" | "local" | "empty" } {
  const pick = (v: DraftValues): DraftValues => ({ scores: v.scores, remarks: v.remarks, domainIds: v.domainIds, decision: v.decision ?? null });
  if (server?.status === "COMPLETED") return { source: "server", ...pick(server) };
  const serverTime = server ? Date.parse(server.updatedAt) : 0;
  if (local && local.savedAt > serverTime && (!server || !sameDraft(local, server))) {
    return { source: "local", ...pick(local) };
  }
  if (server) return { source: "server", ...pick(server) };
  return { source: "empty", scores: {}, remarks: "", domainIds: [], decision: null };
}
