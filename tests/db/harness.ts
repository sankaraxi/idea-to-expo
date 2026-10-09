import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { createUser } from "@/lib/services/auth";
import { createEvaluator } from "@/lib/services/evaluators";
import { closePool } from "@/lib/db/pool";
import { one, pool, rows, run, uuid } from "@/lib/db/sql";
import { AppError } from "@/lib/errors";

/**
 * DB tests run against a real MySQL server. Point MYSQL_TEST_URL at one whose
 * user may create databases, e.g. mysql://root:password@127.0.0.1:3306
 * Every test gets a fresh database built from database/idea_to_expo.sql (the
 * same file you import), and it is dropped afterwards. Tests are skipped
 * when MYSQL_TEST_URL is not set.
 */
export const MYSQL_TEST_URL = process.env.MYSQL_TEST_URL ?? "";
export const hasMysql = MYSQL_TEST_URL !== "";

const SCHEMA = readFileSync(join(import.meta.dirname, "..", "..", "database", "idea_to_expo.sql"), "utf8");

export interface TestDb {
  name: string;
  /** Re-runs the import file on the same database (it must be idempotent). */
  reimport(): Promise<void>;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `ite_test_${randomBytes(5).toString("hex")}`;
  const admin = await mysql.createConnection({ uri: MYSQL_TEST_URL, multipleStatements: true });
  try {
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.query(SCHEMA.replace(/`idea_to_expo`/g, `\`${name}\``));
  } finally {
    await admin.end();
  }
  const url = new URL(MYSQL_TEST_URL);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  await closePool(); // the next query opens a pool on the new database
  return {
    name,
    async reimport() {
      const conn = await mysql.createConnection({ uri: MYSQL_TEST_URL, multipleStatements: true });
      try {
        await conn.query(SCHEMA.replace(/`idea_to_expo`/g, `\`${name}\``));
      } finally {
        await conn.end();
      }
    },
    async drop() {
      await closePool();
      const conn = await mysql.createConnection({ uri: MYSQL_TEST_URL });
      try {
        await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
      } finally {
        await conn.end();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export async function createAdmin(email = "admin@example.edu", password = "admin-password-1") {
  return createUser({ email, password, role: "ADMIN", fullName: "Admin" });
}

export async function createEvaluatorAccount(email: string, name = email, password = "evaluator-password-1") {
  const admin = await createAdmin(`admin+${uuid()}@example.edu`);
  const evaluatorId = await createEvaluator(admin, { name, email, employeeId: null, department: null, password });
  const user = await one<{ user_id: string }>(pool(), "SELECT user_id FROM evaluators WHERE id = ?", [evaluatorId]);
  return { evaluatorId, userId: user!.user_id, email, password, adminId: admin };
}

export async function createStudent(registerNumber: string, extra: { name?: string; department?: string; email?: string | null } = {}) {
  const id = uuid();
  await run(pool(), "INSERT INTO students (id, register_number, name, department, email, phone, source) VALUES (?, ?, ?, ?, ?, ?, 'SEED')", [
    id,
    registerNumber,
    extra.name ?? `Student ${registerNumber}`,
    extra.department ?? "CSE",
    extra.email === undefined ? `${registerNumber.toLowerCase()}@example.edu` : extra.email,
    "9999999999",
  ]);
  await run(pool(), "INSERT INTO ideas (id, student_id, problem_statement, abstract, ppt_url) VALUES (?, ?, 'A problem', 'An abstract', 'https://example.com/p.pptx')", [uuid(), id]);
  return id;
}

export async function createCriterion(name: string, maxMarks: number, style = "SLIDER", sortOrder = 0) {
  const id = uuid();
  await run(pool(), "INSERT INTO evaluation_criteria (id, name, max_marks, input_style, sort_order) VALUES (?, ?, ?, ?, ?)", [id, name, maxMarks, style, sortOrder]);
  return id;
}

export async function createDomain(name: string) {
  const id = uuid();
  await run(pool(), "INSERT INTO domains (id, name) VALUES (?, ?)", [id, name]);
  return id;
}

export const setEventStatus = (status: string) => run(pool(), "UPDATE app_settings SET event_status = ? WHERE id = 1", [status]);

export const count = async (table: string, where = "1=1", params: unknown[] = []) =>
  Number((await one<{ n: number }>(pool(), `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params))!.n);

export const select = <T>(sql: string, params: unknown[] = []) => rows<T>(pool(), sql, params);

/** Awaits a rejection and asserts it is an AppError with the given code (or a MySQL error matching `code`). */
export async function rejectsWith(promise: Promise<unknown>, code: string | RegExp) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError && typeof code === "string" && error.code === code) return;
    const text = `${(error as { code?: string }).code ?? ""} ${(error as Error).message}`;
    if (typeof code === "string" ? text.includes(code) : code.test(text)) return;
    throw new Error(`Expected "${code}", got ${error instanceof AppError ? `AppError(${error.code})` : text}`);
  }
  throw new Error(`Expected rejection "${code}", but the promise resolved`);
}
