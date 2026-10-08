/**
 * Local draft recovery. Every keystroke is mirrored to localStorage; the
 * server holds the debounced copy. On load we pick whichever is newer, so a
 * refresh, crash or network drop never loses an evaluator's work.
 */

export interface LocalDraft {
  score: number | null;
  remarks: string;
  savedAt: number;
}

export interface ServerDraft {
  score: number | null;
  remarks: string;
  status: "IN_PROGRESS" | "COMPLETED";
  updatedAt: string;
}

export const draftKey = (assignmentId: string) => `ite:draft:${assignmentId}`;

export function parseLocalDraft(raw: string | null): LocalDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LocalDraft>;
    const score =
      typeof value.score === "number" && Number.isInteger(value.score) && value.score >= 1 && value.score <= 10
        ? value.score
        : null;
    if (typeof value.savedAt !== "number" || typeof value.remarks !== "string") return null;
    return { score, remarks: value.remarks.slice(0, 5000), savedAt: value.savedAt };
  } catch {
    return null;
  }
}

export function chooseInitialDraft(
  server: ServerDraft | null,
  local: LocalDraft | null,
): { source: "server" | "local" | "empty"; score: number | null; remarks: string } {
  if (server?.status === "COMPLETED") return { source: "server", score: server.score, remarks: server.remarks };
  const serverTime = server ? Date.parse(server.updatedAt) : 0;
  if (local && local.savedAt > serverTime) {
    const differs = !server || local.score !== server.score || local.remarks.trim() !== server.remarks.trim();
    if (differs) return { source: "local", score: local.score, remarks: local.remarks };
  }
  if (server) return { source: "server", score: server.score, remarks: server.remarks };
  return { source: "empty", score: null, remarks: "" };
}
