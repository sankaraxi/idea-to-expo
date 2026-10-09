import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolConnection, ResultSetHeader } from "mysql2/promise";
import { getPool } from "./pool";

/** A pool or a transaction connection — both expose `query`. */
export type Queryable = Pick<PoolConnection, "query">;

export const uuid = () => randomUUID();

export async function rows<T>(db: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const [result] = await db.query(sql, params);
  return result as T[];
}

export async function one<T>(db: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  return (await rows<T>(db, sql, params))[0] ?? null;
}

export async function run(db: Queryable, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [result] = await db.query(sql, params);
  return result as ResultSetHeader;
}

/** The pool as a Queryable (the default for reads outside a transaction). */
export const pool = (): Queryable => getPool();

const RETRYABLE = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);

export function isMysqlError(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && (error as { code?: string }).code === code;
}

/**
 * Runs `fn` in a transaction. Deadlocks and lock-wait timeouts (normal under
 * contention) are retried with backoff — `fn` therefore must not have side
 * effects outside the database.
 */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (error) {
      await conn.rollback().catch(() => {});
      const code = (error as { code?: string })?.code;
      if (code && RETRYABLE.has(code) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 30 * 2 ** attempt + Math.random() * 30));
        continue;
      }
      throw error;
    } finally {
      conn.release();
    }
  }
}

/** Splits an array for `IN (?)` queries; also avoids the invalid `IN ()`. */
export function chunk<T>(items: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function rowsIn<T>(
  db: Queryable,
  ids: readonly string[],
  sql: (placeholder: string) => string,
  extra: unknown[] = [],
): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk([...new Set(ids)])) out.push(...(await rows<T>(db, sql("(?)"), [part, ...extra])));
  return out;
}

/** Escapes LIKE wildcards in user input (MySQL's default escape character is a backslash). */
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (m) => `\\${m}`);

export const toDate = (value: string | Date | null | undefined): Date | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};
