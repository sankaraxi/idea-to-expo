// Shared helpers for the CLI scripts (plain Node; no Next.js).
import mysql from "mysql2/promise";

/** Same URL rules as lib/db/pool.ts: mysql://user:pass@host:3306/db[?ssl=true] */
export async function connect() {
  const raw = process.env.DATABASE_URL;
  if (!raw || !/^mysql:\/\//i.test(raw)) {
    console.error("DATABASE_URL is not set. Example: DATABASE_URL=mysql://root:password@127.0.0.1:3306/idea_to_expo");
    process.exit(1);
  }
  const url = new URL(raw);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    console.error("DATABASE_URL must include the database name (…/idea_to_expo).");
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    charset: "utf8mb4",
    timezone: "Z",
    ssl: url.searchParams.get("ssl") === "true" ? { minVersion: "TLSv1.2", rejectUnauthorized: true } : undefined,
  }).catch((error) => {
    console.error(`Could not connect to MySQL: ${error.code ?? ""} ${error.message}`);
    console.error("Is the server running, are the credentials right, and was database/idea_to_expo.sql imported?");
    process.exit(1);
  });
  await conn.query("SET time_zone = '+00:00'");
  return conn;
}

export async function assertSchema(conn) {
  try {
    await conn.query("SELECT 1 FROM app_settings LIMIT 1");
  } catch {
    console.error("The database has no Idea to Expo tables. Import database/idea_to_expo.sql first.");
    process.exit(1);
  }
}
