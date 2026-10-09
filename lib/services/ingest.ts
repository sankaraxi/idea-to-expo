import "server-only";
import { getPool } from "@/lib/db/pool";
import { isMysqlError, pool, rowsIn, run, toDate, uuid, withTransaction } from "@/lib/db/sql";
import type { NormalizedSubmission } from "@/lib/forms/mapping";
import type { StudentCsvRow } from "@/lib/forms/students-csv";
import type { IdeaRow, MatchedBy, StudentRow } from "@/types/database";
import { writeAudit } from "./audit";
import { enqueueSync, RESULTS_KEY } from "./sync-queue";

export interface IngestError {
  row?: string | number;
  register_number?: string;
  email?: string;
  error: string;
}

export interface IngestResult {
  run_id: string | null;
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  received: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: IngestError[];
}

type Source = "APPS_SCRIPT" | "SHEETS_PULL" | "CSV_IMPORT";

const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );

const dbMessage = (error: unknown) => {
  const e = error as { sqlMessage?: string; message?: string };
  return (e.sqlMessage ?? e.message ?? "Database error").slice(0, 200);
};

export async function recordRun(
  source: Source,
  counts: Pick<IngestResult, "received" | "inserted" | "updated" | "unchanged" | "skipped" | "errors">,
  actorId: string | null,
): Promise<IngestResult> {
  const status: IngestResult["status"] =
    counts.skipped === 0 ? "SUCCESS" : counts.skipped < counts.received ? "PARTIAL" : "FAILED";
  const id = uuid();
  await withTransaction(async (tx) => {
    await run(
      tx,
      `INSERT INTO form_sync_runs (id, source, status, received, inserted, updated, unchanged, skipped, errors, triggered_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
      [id, source, status, counts.received, counts.inserted, counts.updated, counts.unchanged, counts.skipped, JSON.stringify(counts.errors.slice(0, 200)), actorId],
    );
    await writeAudit(tx, {
      userId: actorId,
      action: source === "CSV_IMPORT" ? "STUDENT_IMPORT" : "GOOGLE_FORM_SYNC",
      entityType: "form_sync_run",
      entityId: id,
      metadata: { source, received: counts.received, inserted: counts.inserted, updated: counts.updated, skipped: counts.skipped },
    });
  });
  return { run_id: id, status, ...counts };
}

/** Records a run that failed before any row was processed (e.g. missing columns). */
export const recordFailedRun = (source: Source, received: number, error: string, actorId: string | null) =>
  recordRun(source, { received, inserted: 0, updated: 0, unchanged: 0, skipped: received, errors: [{ error }] }, actorId);

/** Serialises ingestion runs (webhook + manual pull) with a MySQL named lock on a dedicated connection. */
async function withIngestLock<T>(fn: () => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.query("SELECT GET_LOCK('idea_to_expo_ingest', 120)");
    return await fn();
  } finally {
    await conn.query("SELECT RELEASE_LOCK('idea_to_expo_ingest')").catch(() => {});
    conn.release();
  }
}

const unique = <T>(values: (T | null | undefined | "")[]) => [...new Set(values.filter((v): v is T => !!v))];

// ---------------------------------------------------------------------------
// Student CSV (master data)
// ---------------------------------------------------------------------------

export async function importStudents(input: readonly StudentCsvRow[], actorId: string | null): Promise<IngestResult> {
  return withIngestLock(async () => {
    const counts = { received: input.length, inserted: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] as IngestError[] };
    const existing = await rowsIn<StudentRow>(pool(), unique(input.map((r) => r.register_number)), (ph) => `SELECT * FROM students WHERE register_number IN ${ph}`);
    const byReg = new Map(existing.map((s) => [s.register_number, s]));
    const owners = new Map<string, string>(); // email -> register number that owns it
    for (const s of await rowsIn<Pick<StudentRow, "register_number" | "email">>(
      pool(),
      unique(input.map((r) => r.email)),
      (ph) => `SELECT register_number, email FROM students WHERE email IN ${ph}`,
    )) {
      if (s.email) owners.set(s.email.toLowerCase(), s.register_number);
    }

    const skip = (r: StudentCsvRow, error: string) => {
      counts.skipped++;
      counts.errors.push({ row: r._row, register_number: r.register_number, error });
    };

    for (const r of input) {
      if (!r.register_number || !r.name) {
        skip(r, "Register number and name are required");
        continue;
      }
      const owner = r.email ? owners.get(r.email) : undefined;
      if (r.email && owner && owner !== r.register_number) {
        skip(r, `Email ${r.email} already belongs to another student (${owner})`);
        continue;
      }
      try {
        const current = byReg.get(r.register_number);
        if (!current) {
          const id = uuid();
          await withTransaction(async (tx) => {
            await run(
              tx,
              "INSERT INTO students (id, register_number, name, gender, department, email, phone, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'IMPORT')",
              [id, r.register_number, r.name, r.gender, r.department, r.email, r.phone],
            );
            await enqueueSync(tx, "STUDENT", id);
          });
          byReg.set(r.register_number, { id, register_number: r.register_number, name: r.name, email: r.email } as StudentRow);
          if (r.email) owners.set(r.email, r.register_number);
          counts.inserted++;
          continue;
        }
        // Blank CSV cells keep the stored value.
        const next = {
          name: r.name,
          gender: r.gender ?? current.gender,
          department: r.department ?? current.department,
          email: r.email ?? current.email,
          phone: r.phone ?? current.phone,
        };
        const fromForm = current.source === "FORM";
        const changed =
          next.name !== current.name || next.gender !== current.gender || next.department !== current.department ||
          next.email !== current.email || next.phone !== current.phone || fromForm;
        if (!changed) {
          counts.unchanged++;
          continue;
        }
        await withTransaction(async (tx) => {
          await run(
            tx,
            "UPDATE students SET name = ?, gender = ?, department = ?, email = ?, phone = ?, source = IF(source = 'FORM', 'IMPORT', source) WHERE id = ?",
            [next.name, next.gender, next.department, next.email, next.phone, current.id],
          );
          // Now part of the CSV: no longer flagged "not in CSV".
          await run(tx, "UPDATE ideas SET matched_by = 'REGISTER_NUMBER' WHERE student_id = ? AND matched_by = 'CREATED'", [current.id]);
          await enqueueSync(tx, "STUDENT", current.id);
          await enqueueSync(tx, "RESULTS", RESULTS_KEY);
        });
        byReg.set(r.register_number, { ...current, ...next, source: fromForm ? "IMPORT" : current.source });
        if (next.email) owners.set(next.email, r.register_number);
        counts.updated++;
      } catch (error) {
        skip(r, isMysqlError(error, "ER_DUP_ENTRY") ? "Duplicate register number or email" : dbMessage(error));
      }
    }
    return recordRun("CSV_IMPORT", counts, actorId);
  });
}

// ---------------------------------------------------------------------------
// Problem statement responses
// ---------------------------------------------------------------------------

/**
 * Links each response to a student by register number, then email. Unmatched
 * responses create a student flagged "not in CSV" so no submission is lost.
 * Student master fields are only ever filled when blank; an older response
 * never replaces a newer one; replays are idempotent.
 */
export async function ingestSubmissions(
  input: readonly NormalizedSubmission[],
  source: "APPS_SCRIPT" | "SHEETS_PULL",
  actorId: string | null,
): Promise<IngestResult> {
  return withIngestLock(async () => {
    const counts = { received: input.length, inserted: 0, updated: 0, unchanged: 0, skipped: 0, errors: [] as IngestError[] };

    const students = new Map<string, StudentRow>();
    const regMap = new Map<string, StudentRow>();
    const emailMap = new Map<string, StudentRow>();
    const remember = (s: StudentRow) => {
      students.set(s.id, s);
      regMap.set(s.register_number, s);
      if (s.email) emailMap.set(s.email.toLowerCase(), s);
    };
    for (const s of await rowsIn<StudentRow>(pool(), unique(input.map((r) => r.register_number)), (ph) => `SELECT * FROM students WHERE register_number IN ${ph}`)) remember(s);
    for (const s of await rowsIn<StudentRow>(pool(), unique(input.map((r) => r.email)), (ph) => `SELECT * FROM students WHERE email IN ${ph}`)) remember(s);

    const ids = [...students.keys()];
    const ideas = new Map((await rowsIn<IdeaRow>(pool(), ids, (ph) => `SELECT * FROM ideas WHERE student_id IN ${ph}`)).map((i) => [i.student_id, i]));
    const evaluated = new Set(
      (await rowsIn<{ student_id: string }>(pool(), ids, (ph) => `SELECT student_id FROM evaluations WHERE status = 'COMPLETED' AND student_id IN ${ph}`)).map((e) => e.student_id),
    );

    for (const r of input) {
      try {
        const reg = r.register_number;
        const email = r.email?.toLowerCase() ?? null;
        const submittedAt = toDate(r.submitted_at);
        if (!reg && !email) {
          counts.skipped++;
          counts.errors.push({ row: r._row, error: "Missing register number and email" });
          continue;
        }

        const other: Record<string, string> = { ...r.other_details };
        let student = reg ? regMap.get(reg) : undefined;
        let matched: MatchedBy | null = student ? "REGISTER_NUMBER" : null;
        if (!student && email) {
          const byEmail = emailMap.get(email);
          if (byEmail) {
            student = byEmail;
            matched = "EMAIL";
            if (reg && reg !== byEmail.register_number) other["Register number on form"] = reg;
          }
        }

        let create = false;
        const patch: Record<string, unknown> = {};
        if (!student) {
          if (!reg || !r.name) {
            counts.skipped++;
            counts.errors.push({
              row: r._row,
              register_number: reg,
              email: email ?? undefined,
              error: "No matching student by register number or email, and the response lacks a register number or name",
            });
            continue;
          }
          create = true;
          matched = "CREATED";
          student = {
            id: uuid(), register_number: reg, name: r.name, gender: null, department: r.department, year: null, section: r.section,
            email: email && !emailMap.has(email) ? email : null, phone: r.phone, status: "ACTIVE", source: "FORM",
            form_submitted_at: submittedAt?.toISOString() ?? null, tie_break_priority: null, created_at: "", updated_at: "",
          };
        } else {
          // Fill blanks only; imported master data wins. Students created from a form stay flagged.
          if (student.source === "FORM") matched = "CREATED";
          if (!student.department && r.department) patch.department = r.department;
          if (!student.section && r.section) patch.section = r.section;
          if (!student.phone && r.phone) patch.phone = r.phone;
          if (!student.email && email && !emailMap.has(email)) patch.email = email;
          const latest = [student.form_submitted_at, submittedAt?.toISOString()].filter(Boolean).sort().pop() ?? null;
          if (latest && latest !== student.form_submitted_at) patch.form_submitted_at = new Date(latest);
        }

        const existingIdea = ideas.get(student.id);
        if (!create && existingIdea?.submitted_at && submittedAt && submittedAt.getTime() < Date.parse(existingIdea.submitted_at)) {
          counts.unchanged++; // an older response than the one we already have
          continue;
        }

        const next = {
          abstract: r.abstract,
          ppt_url: r.ppt_url,
          other_details: other,
          submission_status: r.abstract && r.ppt_url ? ("SUBMITTED" as const) : ("INCOMPLETE" as const),
          submitted_at: submittedAt,
          response_row: r._row,
          matched_by: matched!,
        };
        const ideaChanged =
          !existingIdea ||
          existingIdea.abstract !== next.abstract || existingIdea.ppt_url !== next.ppt_url ||
          stable(existingIdea.other_details) !== stable(next.other_details) ||
          existingIdea.submission_status !== next.submission_status ||
          (existingIdea.submitted_at ? Date.parse(existingIdea.submitted_at) : null) !== (next.submitted_at?.getTime() ?? null) ||
          existingIdea.response_row !== next.response_row || existingIdea.matched_by !== next.matched_by;
        const studentChanged = create || Object.keys(patch).length > 0;

        if (!studentChanged && !ideaChanged) {
          counts.unchanged++;
          continue;
        }

        const studentId = student.id;
        const ideaId = existingIdea?.id ?? uuid();
        await withTransaction(async (tx) => {
          if (create) {
            await run(
              tx,
              "INSERT INTO students (id, register_number, name, department, section, email, phone, source, form_submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'FORM', ?)",
              [studentId, student!.register_number, student!.name, student!.department, student!.section, student!.email, student!.phone, submittedAt],
            );
          } else if (Object.keys(patch).length > 0) {
            const cols = Object.keys(patch);
            await run(tx, `UPDATE students SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...cols.map((c) => patch[c]), studentId]);
          }
          if (ideaChanged) {
            const values = [next.abstract, next.ppt_url, JSON.stringify(next.other_details), next.submission_status, next.submitted_at, next.response_row, next.matched_by];
            if (existingIdea) {
              await run(
                tx,
                "UPDATE ideas SET abstract = ?, ppt_url = ?, other_details = CAST(? AS JSON), submission_status = ?, submitted_at = ?, response_row = ?, matched_by = ? WHERE id = ?",
                [...values, existingIdea.id],
              );
            } else {
              await run(
                tx,
                "INSERT INTO ideas (id, student_id, abstract, ppt_url, other_details, submission_status, submitted_at, response_row, matched_by) VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?)",
                [ideaId, studentId, ...values],
              );
            }
          }
          await enqueueSync(tx, "STUDENT", studentId);
          if (evaluated.has(studentId)) await enqueueSync(tx, "RESPONSE_ROW", studentId);
        });

        // Keep the in-memory view current for later rows of the same batch.
        const stored = create ? student : { ...student, ...patch, form_submitted_at: (patch.form_submitted_at as Date | undefined)?.toISOString() ?? student.form_submitted_at };
        remember(stored as StudentRow);
        ideas.set(studentId, {
          ...(existingIdea ?? ({ id: ideaId, student_id: studentId } as IdeaRow)),
          abstract: next.abstract, ppt_url: next.ppt_url, other_details: next.other_details, submission_status: next.submission_status,
          submitted_at: next.submitted_at?.toISOString() ?? null, response_row: next.response_row, matched_by: next.matched_by,
        } as IdeaRow);

        if (!existingIdea) counts.inserted++;
        else counts.updated++;
      } catch (error) {
        counts.skipped++;
        counts.errors.push({ row: r._row, register_number: r.register_number, error: dbMessage(error) });
      }
    }
    return recordRun(source, counts, actorId);
  });
}

