import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { hashPassword, verifyDummyPassword, verifyPassword } from "@/lib/auth/password";
import { one, pool, rows, run, uuid, withTransaction, type Queryable } from "@/lib/db/sql";
import type { AppRole } from "@/types/database";

export interface SessionUser {
  id: string;
  email: string;
  role: AppRole;
  name: string;
  /** Present for EVALUATOR users with an ACTIVE evaluator record. */
  evaluatorId: string | null;
}

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createUser(
  input: { email: string; password: string; role: AppRole; fullName: string | null },
  db: Queryable = pool(),
): Promise<string> {
  const id = uuid();
  await run(db, "INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, ?, ?)", [
    id,
    input.email.trim().toLowerCase(),
    await hashPassword(input.password),
    input.role,
    input.fullName,
  ]);
  return id;
}

/** Returns the user id when email + password are right and the account is active; otherwise null. */
export async function authenticate(email: string, password: string): Promise<{ id: string; role: AppRole } | null> {
  const user = await one<{ id: string; password_hash: string; role: AppRole; is_active: boolean }>(
    pool(),
    "SELECT id, password_hash, role, is_active FROM users WHERE email = ?",
    [email.trim().toLowerCase()],
  );
  if (!user) {
    await verifyDummyPassword(password);
    return null;
  }
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid || !user.is_active) return null;
  await run(pool(), "UPDATE users SET last_login_at = NOW(3) WHERE id = ?", [user.id]);
  return { id: user.id, role: user.role };
}

export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  await run(pool(), "DELETE FROM sessions WHERE expires_at < NOW(3)"); // opportunistic cleanup
  await run(
    pool(),
    "INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, NOW(3) + INTERVAL ? SECOND, ?, ?)",
    [hashToken(token), userId, SESSION_TTL_SECONDS, meta.ip?.slice(0, 64) ?? null, meta.userAgent?.slice(0, 255) ?? null],
  );
  return { token, expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000) };
}

/**
 * Resolves a cookie token to the signed-in user, or null. Deactivated users
 * and expired sessions never resolve; a session in the second half of its life
 * is extended (sliding expiry).
 */
export async function resolveSession(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const id = hashToken(token);
  const row = await one<{ id: string; email: string; role: AppRole; full_name: string | null; expires_at: string }>(
    pool(),
    `SELECT u.id, u.email, u.role, u.full_name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > NOW(3) AND u.is_active = 1`,
    [id],
  );
  if (!row) return null;

  if (Date.parse(row.expires_at) - Date.now() < (SESSION_TTL_SECONDS * 1000) / 2) {
    await run(pool(), "UPDATE sessions SET expires_at = NOW(3) + INTERVAL ? SECOND, last_seen_at = NOW(3) WHERE id = ?", [
      SESSION_TTL_SECONDS,
      id,
    ]);
  }

  let evaluatorId: string | null = null;
  let name = row.full_name ?? row.email;
  if (row.role === "EVALUATOR") {
    const evaluator = await one<{ id: string; name: string; status: "ACTIVE" | "DISABLED" }>(
      pool(),
      "SELECT id, name, status FROM evaluators WHERE user_id = ?",
      [row.id],
    );
    if (evaluator?.status === "ACTIVE") evaluatorId = evaluator.id;
    if (evaluator) name = evaluator.name;
  }
  return { id: row.id, email: row.email, role: row.role, name, evaluatorId };
}

export async function destroySession(token: string | undefined | null) {
  if (token && TOKEN_PATTERN.test(token)) await run(pool(), "DELETE FROM sessions WHERE id = ?", [hashToken(token)]);
}

/** Signs a user out everywhere (used when disabling an account or resetting a password). */
export async function destroyUserSessions(userId: string, db: Queryable = pool()) {
  await run(db, "DELETE FROM sessions WHERE user_id = ?", [userId]);
}

export async function setPassword(userId: string, password: string) {
  const hash = await hashPassword(password);
  await withTransaction(async (tx) => {
    await run(tx, "UPDATE users SET password_hash = ? WHERE id = ?", [hash, userId]);
    await destroyUserSessions(userId, tx);
  });
}

/** Active admin/evaluator accounts, newest first (diagnostics for scripts). */
export async function listUsers() {
  return rows<{ id: string; email: string; role: AppRole; is_active: boolean }>(
    pool(),
    "SELECT id, email, role, is_active FROM users ORDER BY created_at DESC",
  );
}
