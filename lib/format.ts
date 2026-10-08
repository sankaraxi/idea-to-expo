export function formatDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(
    new Date(iso),
  );
}

export function pageParam(value: string | string[] | undefined) {
  const n = Number(typeof value === "string" ? value : 1);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export function stringParam(value: string | string[] | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

/** Escapes PostgREST ilike/or() special characters in user search text. */
export function searchTerm(value: string) {
  return value.replace(/[%,()*\\]/g, " ").trim().slice(0, 100);
}
