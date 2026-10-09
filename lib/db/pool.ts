import "server-only";
import mysql, { type Pool, type PoolOptions } from "mysql2/promise";
import { databaseUrl } from "@/lib/env";

declare global {
  var __iteMysqlPool: Pool | undefined;
}

interface MysqlField {
  type: string;
  length: number;
  string(): string | null;
}

/**
 * Column conversions applied to every query:
 *  - DATETIME/TIMESTAMP -> ISO-8601 UTC string (the app always stores UTC)
 *  - TINYINT(1)         -> boolean
 * JSON columns are parsed and DECIMAL/BIGINT come back as numbers (see options).
 */
function typeCast(field: MysqlField, next: () => unknown) {
  if (field.type === "DATETIME" || field.type === "TIMESTAMP") {
    const raw = field.string();
    if (!raw) return null;
    return new Date(`${raw.replace(" ", "T")}Z`).toISOString();
  }
  if (field.type === "TINY" && field.length === 1) {
    const raw = field.string();
    return raw === null ? null : raw === "1";
  }
  return next();
}

/** Parses mysql://user:pass@host:3306/db[?ssl=true] (percent-decodes user, password and database). */
export function parseDatabaseUrl(raw: string): PoolOptions {
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error("DATABASE_URL must include the database name, e.g. mysql://user:pass@host:3306/idea_to_expo");
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    // ?ssl=true for managed MySQL (PlanetScale, RDS, Azure, …)
    ssl: url.searchParams.get("ssl") === "true" ? { minVersion: "TLSv1.2", rejectUnauthorized: true } : undefined,
  };
}

function createPool(): Pool {
  const pool = mysql.createPool({
    ...parseDatabaseUrl(databaseUrl()),
    charset: "utf8mb4",
    timezone: "Z",
    connectionLimit: Number(process.env.DATABASE_POOL_SIZE) || 10,
    waitForConnections: true,
    queueLimit: 0,
    connectTimeout: 10_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30_000,
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: true,
    typeCast,
  });
  // Every connection: UTC clock, and READ COMMITTED so each statement (incl. the
  // existence checks done after taking a row lock) sees the latest committed data.
  pool.pool.on("connection", (conn) => {
    conn.query("SET time_zone = '+00:00'");
    conn.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
  });
  return pool;
}

export function getPool(): Pool {
  // Cached on globalThis so Next.js dev hot-reloads do not leak connections.
  globalThis.__iteMysqlPool ??= createPool();
  return globalThis.__iteMysqlPool;
}

/** Closes and forgets the pool (tests, scripts). */
export async function closePool() {
  const pool = globalThis.__iteMysqlPool;
  globalThis.__iteMysqlPool = undefined;
  if (pool) await pool.end();
}
