import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * Minimal stand-in for the parts of Supabase the migrations depend on:
 * the anon/authenticated/service_role roles and the auth schema helpers.
 * auth.uid()/auth.role() read the same GUCs PostgREST sets per request.
 */
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    created_at timestamptz not null default now()
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claim.role', true), '')
  $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant execute on function auth.role() to anon, authenticated, service_role;
`;

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "supabase", "migrations");

let template: Promise<PGlite> | null = null;
let current: PGlite | null = null;

/**
 * Returns a fresh, fully migrated database cloned from a per-worker template.
 * The previous clone is closed first: each instance holds its own WASM heap.
 */
export async function createTestDb(): Promise<PGlite> {
  template ??= buildMigratedDb();
  if (current && !current.closed) await current.close();
  current = (await (await template).clone()) as PGlite;
  return current;
}

async function buildMigratedDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    } catch (error) {
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
    }
  }
  return db;
}

type Role = "anon" | "authenticated" | "service_role";

/** Runs `fn` as a given Postgres role + JWT subject, then resets to superuser. */
export async function as<T>(
  db: PGlite,
  role: Role,
  userId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId ?? ""}', false);
                 select set_config('request.jwt.claim.role', '${role}', false);
                 set role ${role};`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;
                   select set_config('request.jwt.claim.sub', '', false);
                   select set_config('request.jwt.claim.role', '', false);`);
  }
}

export async function createUser(db: PGlite, email: string, role: "ADMIN" | "EVALUATOR") {
  const { rows } = await db.query<{ id: string }>(
    "insert into auth.users (email) values ($1) returning id",
    [email],
  );
  const id = rows[0].id;
  await db.query("insert into public.profiles (id, role, email, full_name) values ($1, $2, $3, $3)", [
    id,
    role,
    email,
  ]);
  return id;
}

export async function createEvaluator(db: PGlite, email: string, name = email) {
  const userId = await createUser(db, email, "EVALUATOR");
  const { rows } = await db.query<{ id: string }>(
    "insert into public.evaluators (user_id, name, email) values ($1, $2, $3) returning id",
    [userId, name, email],
  );
  return { userId, evaluatorId: rows[0].id };
}

export async function createStudent(db: PGlite, registerNumber: string, extra: Record<string, unknown> = {}) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.students (register_number, name, department, email, phone, source)
     values ($1, $2, $3, $4, $5, 'SEED') returning id`,
    [
      registerNumber,
      (extra.name as string) ?? `Student ${registerNumber}`,
      (extra.department as string) ?? "CSE",
      (extra.email as string) ?? `${registerNumber.toLowerCase()}@example.edu`,
      "9999999999",
    ],
  );
  await db.query(
    "insert into public.ideas (student_id, abstract, ppt_url) values ($1, 'An abstract', 'https://example.com/p.pptx')",
    [rows[0].id],
  );
  return rows[0].id;
}

export async function createCriterion(db: PGlite, name: string, maxMarks: number, style = "SLIDER") {
  const { rows } = await db.query<{ id: string }>(
    "insert into public.evaluation_criteria (name, max_marks, input_style) values ($1, $2, $3) returning id",
    [name, maxMarks, style],
  );
  return rows[0].id;
}

export async function createDomain(db: PGlite, name: string) {
  const { rows } = await db.query<{ id: string }>("insert into public.domains (name) values ($1) returning id", [name]);
  return rows[0].id;
}

export async function setEventStatus(db: PGlite, status: string) {
  await db.query("update public.app_settings set event_status = $1 where id", [status]);
}

/** Expects a promise to reject with a Postgres error whose message contains `code`. */
export async function rejectsWith(promise: Promise<unknown>, code: string | RegExp) {
  try {
    await promise;
  } catch (error) {
    const message = (error as Error).message;
    if (typeof code === "string" ? message.includes(code) : code.test(message)) return;
    throw new Error(`Expected error matching ${code}, got: ${message}`);
  }
  throw new Error(`Expected rejection matching ${code}, but promise resolved`);
}
