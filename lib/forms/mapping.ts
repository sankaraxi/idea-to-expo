import { z } from "zod";

/**
 * Google Form → portal field mapping.
 *
 * Form questions vary between events, so headers are matched against a list
 * of aliases per portal field (configurable in Admin → Settings and stored in
 * app_settings.form_field_mapping). Unmapped columns are preserved in
 * ideas.other_details unless listed in `ignore`.
 */

export const FORM_FIELDS = [
  "submitted_at",
  "register_number",
  "name",
  "department",
  "year",
  "section",
  "email",
  "phone",
  "title",
  "problem_statement",
  "idea_description",
  "team_details",
  "ppt_url",
] as const;

export type FormField = (typeof FORM_FIELDS)[number];

export const FORM_FIELD_LABELS: Record<FormField, string> = {
  submitted_at: "Submission timestamp",
  register_number: "Register number (unique id)",
  name: "Student name",
  department: "Department",
  year: "Year",
  section: "Section",
  email: "Email",
  phone: "Phone",
  title: "Idea title",
  problem_statement: "Problem statement",
  idea_description: "Idea description",
  team_details: "Team details",
  ppt_url: "PPT / presentation URL",
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
    name: ["Student Name", "Name", "Full Name", "Name of the Student"],
    department: ["Department", "Dept", "Branch"],
    year: ["Year", "Year of Study"],
    section: ["Section", "Class"],
    email: ["Email", "Email Address", "Email ID", "Mail ID"],
    phone: ["Phone", "Phone Number", "Mobile", "Mobile Number", "Contact Number"],
    title: ["Idea Title", "Project Title", "Title"],
    problem_statement: ["Problem Statement", "Problem"],
    idea_description: ["Idea Description", "Description", "Proposed Solution", "Solution"],
    team_details: ["Team Details", "Team Members", "Team"],
    ppt_url: ["PPT", "PPT URL", "PPT Link", "Upload PPT", "Presentation", "Presentation URL", "Upload your PPT"],
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

const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Maps each header index to a portal field (first alias match wins per field). */
export function matchHeaders(headers: readonly string[], mapping: FormFieldMapping) {
  const normalized = headers.map((h) => normalizeHeader(String(h ?? "")));
  const ignored = new Set(mapping.ignore.map(normalizeHeader));
  const fieldByIndex = new Map<number, FormField>();
  const used = new Set<number>();

  for (const field of FORM_FIELDS) {
    const aliases = (mapping.fields[field] ?? []).map(normalizeHeader);
    for (const alias of aliases) {
      const index = normalized.findIndex((h, i) => h === alias && !used.has(i));
      if (index >= 0) {
        fieldByIndex.set(index, field);
        used.add(index);
        break;
      }
    }
  }

  const missing = (["register_number", "name"] as const).filter((f) => ![...fieldByIndex.values()].includes(f));
  return { fieldByIndex, ignored, normalized, missing };
}

export interface NormalizedSubmission {
  _row: number;
  register_number: string;
  name: string;
  department: string | null;
  year: number | null;
  section: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  problem_statement: string | null;
  idea_description: string | null;
  team_details: string | null;
  ppt_url: string | null;
  submitted_at: string | null;
  other_details: Record<string, string>;
}

export function normalizeRegisterNumber(value: string): string {
  return value.replace(/\s/g, "").toUpperCase();
}

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };
const WORDS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };

export function parseYear(value: string): number | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const digit = v.match(/\d+/);
  if (digit) {
    const n = Number(digit[0]);
    return n >= 1 && n <= 6 ? n : null;
  }
  const first = v.split(/[\s-]+/)[0];
  return ROMAN[first] ?? WORDS[first] ?? null;
}

/**
 * Accepts ISO strings (Apps Script sends Date.toISOString()) and Google Sheets
 * serial numbers (UNFORMATTED_VALUE reads). Returns ISO or null.
 */
export function parseTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Sheets serial date: days since 1899-12-30.
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

const clean = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s === "" ? null : s;
};

/**
 * Turns raw sheet rows into normalised submissions. `firstDataRow` is the
 * 1-based sheet row of rows[0] (for error messages).
 */
export function normalizeSubmissions(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  mapping: FormFieldMapping,
  firstDataRow = 2,
): { submissions: NormalizedSubmission[]; missingFields: string[] } {
  const { fieldByIndex, ignored, normalized, missing } = matchHeaders(headers, mapping);
  if (missing.length > 0) return { submissions: [], missingFields: missing };

  const submissions: NormalizedSubmission[] = [];
  rows.forEach((row, r) => {
    if (row.every((cell) => clean(cell) === null)) return;

    const values: Partial<Record<FormField, unknown>> = {};
    const other: Record<string, string> = {};
    headers.forEach((header, i) => {
      const field = fieldByIndex.get(i);
      if (field) values[field] = row[i];
      else if (!ignored.has(normalized[i]) && clean(row[i]) !== null && clean(header) !== null) {
        other[String(header).trim()] = String(row[i]).trim().slice(0, 5000);
      }
    });

    const rawPpt = clean(values.ppt_url);
    const ppt = rawPpt ? firstUrl(rawPpt) : null;
    if (rawPpt && rawPpt.includes(",")) other["PPT (all files)"] = rawPpt;

    submissions.push({
      _row: firstDataRow + r,
      register_number: normalizeRegisterNumber(clean(values.register_number) ?? ""),
      name: clean(values.name) ?? "",
      department: clean(values.department),
      year: parseYear(clean(values.year) ?? ""),
      section: clean(values.section),
      email: clean(values.email)?.toLowerCase() ?? null,
      phone: clean(values.phone),
      title: clean(values.title),
      problem_statement: clean(values.problem_statement),
      idea_description: clean(values.idea_description),
      team_details: clean(values.team_details),
      ppt_url: ppt,
      submitted_at: parseTimestamp(values.submitted_at),
      other_details: other,
    });
  });

  return { submissions, missingFields: [] };
}
