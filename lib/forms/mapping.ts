import { z } from "zod";

/**
 * Problem statement form → portal field mapping.
 *
 * Form questions vary between events, so headers are matched against a list
 * of aliases per portal field (configurable in Admin → Settings and stored in
 * app_settings.form_field_mapping). Unmapped columns are kept in
 * ideas.other_details unless ignored — the score/total columns the portal
 * writes back into the same sheet are always ignored.
 */

export const FORM_FIELDS = [
  "submitted_at",
  "register_number",
  "name",
  "email",
  "phone",
  "department",
  "section",
  "abstract",
  "ppt_url",
] as const;

export type FormField = (typeof FORM_FIELDS)[number];

export const FORM_FIELD_LABELS: Record<FormField, string> = {
  submitted_at: "Submission timestamp",
  register_number: "Register number",
  name: "Student name",
  email: "Email address",
  phone: "Phone number",
  department: "Department",
  section: "Section",
  abstract: "Abstract of the idea",
  ppt_url: "Presentation (PPT/PDF Drive link)",
};

export const formFieldMappingSchema = z.object({
  fields: z.partialRecord(z.enum(FORM_FIELDS), z.array(z.string().trim().min(1)).max(20)),
  ignore: z.array(z.string().trim().min(1)).max(100).default([]),
});

export type FormFieldMapping = z.infer<typeof formFieldMappingSchema>;

export const DEFAULT_FORM_FIELD_MAPPING: FormFieldMapping = {
  fields: {
    submitted_at: ["Timestamp", "Submitted At"],
    register_number: ["Register Number", "Register No", "Reg No", "Registration Number", "Roll Number", "Roll No"],
    name: ["Name", "Student Name", "Full Name", "Name of the Student"],
    email: ["Email Address", "Email", "Email ID", "Mail ID"],
    phone: ["Phone Number", "Phone", "Mobile Number", "Mobile", "Contact Number"],
    department: ["Department", "Dept", "Branch"],
    section: ["Section", "Class"],
    abstract: ["Abstract of the idea", "Abstract", "Idea Abstract", "Abstract of your idea"],
    ppt_url: [
      "Your presentation",
      "Your Presentation (PPT/PDF Drive link)",
      "Presentation",
      "PPT",
      "PPT Link",
      "Presentation Link",
      "Drive Link",
    ],
  },
  ignore: [],
};

export function resolveMapping(stored: unknown): FormFieldMapping {
  const parsed = formFieldMappingSchema.safeParse(stored);
  if (!parsed.success || Object.keys(parsed.data.fields).length === 0) return DEFAULT_FORM_FIELD_MAPPING;
  return {
    fields: { ...DEFAULT_FORM_FIELD_MAPPING.fields, ...parsed.data.fields },
    ignore: parsed.data.ignore,
  };
}

export const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Columns organisers add for the portal to fill: "criteria 1", "criteria 2", … and
 * "total score" / "total". They are never read back in as form answers.
 */
export const isScoreColumnHeader = (normalized: string) => /^criteria\d+$/.test(normalized) || normalized === "totalscore" || normalized === "total";

/**
 * Maps header indexes to fields: exact (normalised) alias match first, then
 * "header starts with alias" so long Google Form question titles such as
 * "Your presentation (ppt/pdf's drive link)" still match "Your presentation".
 */
export function matchHeaders<F extends string>(
  headers: readonly string[],
  fields: Partial<Record<F, string[]>>,
  order: readonly F[],
  exclude: ReadonlySet<string> = new Set(),
) {
  const normalized = headers.map((h) => normalizeHeader(String(h ?? "")));
  const fieldByIndex = new Map<number, F>();
  const used = new Set<number>();
  normalized.forEach((h, i) => exclude.has(h) && used.add(i));

  for (const pass of ["exact", "prefix"] as const) {
    for (const field of order) {
      if ([...fieldByIndex.values()].includes(field)) continue;
      for (const alias of (fields[field] ?? []).map(normalizeHeader)) {
        if (!alias) continue;
        const index = normalized.findIndex(
          (h, i) => !used.has(i) && (pass === "exact" ? h === alias : h.startsWith(alias)),
        );
        if (index >= 0) {
          fieldByIndex.set(index, field);
          used.add(index);
          break;
        }
      }
    }
  }
  return { fieldByIndex, normalized };
}

export interface NormalizedSubmission {
  _row: number;
  register_number: string;
  name: string;
  email: string | null;
  phone: string | null;
  department: string | null;
  section: string | null;
  abstract: string | null;
  ppt_url: string | null;
  submitted_at: string | null;
  other_details: Record<string, string>;
}

export function normalizeRegisterNumber(value: string): string {
  return value.replace(/\s/g, "").toUpperCase();
}

/**
 * Accepts ISO strings (Apps Script sends Date.toISOString()) and Google Sheets
 * serial numbers (UNFORMATTED_VALUE reads). Returns ISO or null.
 */
export function parseTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(Math.round((value - 25569) * 86400 * 1000)).toISOString();
  }
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return parseTimestamp(Number(text));
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** Google Forms joins multiple uploaded files with ", ". Keep the first http(s) URL. */
export function firstUrl(value: string): string | null {
  for (const part of value.split(/[,\s]+/)) {
    try {
      const url = new URL(part.trim());
      if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
    } catch {
      // not a URL
    }
  }
  return null;
}

export const clean = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s === "" ? null : s;
};

/**
 * Turns raw response-sheet rows into normalised submissions.
 * `excludeHeaders` are columns the portal owns (scores, total, …) — never ingested.
 */
export function normalizeSubmissions(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  mapping: FormFieldMapping,
  firstDataRow = 2,
  excludeHeaders: readonly string[] = [],
): { submissions: NormalizedSubmission[]; missingFields: string[] } {
  const exclude = new Set([...excludeHeaders, ...mapping.ignore].map(normalizeHeader).filter(Boolean));
  headers.forEach((h) => isScoreColumnHeader(normalizeHeader(String(h ?? ""))) && exclude.add(normalizeHeader(String(h ?? ""))));
  const { fieldByIndex, normalized } = matchHeaders(headers, mapping.fields, FORM_FIELDS, exclude);
  const mapped = new Set(fieldByIndex.values());
  if (!mapped.has("register_number") && !mapped.has("email")) {
    return { submissions: [], missingFields: ["register_number or email"] };
  }

  const submissions: NormalizedSubmission[] = [];
  rows.forEach((row, r) => {
    if (row.every((cell) => clean(cell) === null)) return;
    const values: Partial<Record<FormField, unknown>> = {};
    const other: Record<string, string> = {};
    headers.forEach((header, i) => {
      const field = fieldByIndex.get(i);
      if (field) values[field] = row[i];
      else if (!exclude.has(normalized[i]) && clean(row[i]) !== null && clean(header) !== null) {
        other[String(header).trim()] = String(row[i]).trim().slice(0, 5000);
      }
    });

    const rawPpt = clean(values.ppt_url);
    if (rawPpt && rawPpt.includes(",")) other["Presentation (all files)"] = rawPpt;

    submissions.push({
      _row: firstDataRow + r,
      register_number: normalizeRegisterNumber(clean(values.register_number) ?? ""),
      name: clean(values.name) ?? "",
      email: clean(values.email)?.toLowerCase() ?? null,
      phone: clean(values.phone),
      department: clean(values.department),
      section: clean(values.section),
      abstract: clean(values.abstract),
      ppt_url: rawPpt ? firstUrl(rawPpt) : null,
      submitted_at: parseTimestamp(values.submitted_at),
      other_details: other,
    });
  });
  return { submissions, missingFields: [] };
}
