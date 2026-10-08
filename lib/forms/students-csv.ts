import { clean, matchHeaders, normalizeRegisterNumber } from "./mapping";

/**
 * Student master-data CSV:
 *   name, register number, gender, department, email, phone number
 * Header names are matched loosely (case/punctuation-insensitive, common aliases).
 */

export const STUDENT_CSV_FIELDS = ["register_number", "name", "gender", "department", "email", "phone"] as const;
type StudentCsvField = (typeof STUDENT_CSV_FIELDS)[number];

const ALIASES: Record<StudentCsvField, string[]> = {
  register_number: ["Register Number", "Register No", "Reg No", "Registration Number", "Roll Number", "Roll No"],
  name: ["Name", "Student Name", "Full Name"],
  gender: ["Gender", "Sex"],
  department: ["Department", "Dept", "Branch"],
  email: ["Email", "Email Address", "Email ID", "Mail ID"],
  phone: ["Phone Number", "Phone", "Mobile Number", "Mobile", "Contact Number"],
};

export const STUDENT_CSV_TEMPLATE = "name,register number,gender,department,email,phone number\n";

export interface StudentCsvRow {
  _row: number;
  register_number: string;
  name: string;
  gender: string | null;
  department: string | null;
  email: string | null;
  phone: string | null;
}

export function normalizeGender(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (["m", "male", "boy"].includes(v)) return "Male";
  if (["f", "female", "girl"].includes(v)) return "Female";
  if (["o", "other", "others"].includes(v)) return "Other";
  return value.trim().slice(0, 30);
}

export function parseStudentCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]) {
  const { fieldByIndex } = matchHeaders(headers, ALIASES, STUDENT_CSV_FIELDS);
  const mapped = new Set(fieldByIndex.values());
  const missing = (["register_number", "name"] as const).filter((f) => !mapped.has(f));
  if (missing.length) return { rows: [] as StudentCsvRow[], missingFields: missing as string[] };

  const out: StudentCsvRow[] = [];
  rows.forEach((row, r) => {
    if (row.every((c) => clean(c) === null)) return;
    const v: Partial<Record<StudentCsvField, string | null>> = {};
    fieldByIndex.forEach((field, i) => (v[field] = clean(row[i])));
    out.push({
      _row: r + 2,
      register_number: normalizeRegisterNumber(v.register_number ?? ""),
      name: v.name ?? "",
      gender: normalizeGender(v.gender ?? null),
      department: v.department ?? null,
      email: v.email?.toLowerCase() ?? null,
      phone: v.phone ?? null,
    });
  });
  return { rows: out, missingFields: [] as string[] };
}
