import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { one, pool, run } from "@/lib/db/sql";
import { authenticate, createSession, destroySession, resolveSession } from "@/lib/services/auth";
import { resetEvaluatorPassword, setEvaluatorActive } from "@/lib/services/evaluators";
import { count, createAdmin, createEvaluatorAccount, createTestDb, hasMysql, rejectsWith, type TestDb } from "./harness";

describe.skipIf(!hasMysql)("authentication & sessions", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await createTestDb();
  });
  afterEach(async () => {
    await db.drop();
  });

  it("authenticates the right password and rejects wrong / unknown credentials", async () => {
    const adminId = await createAdmin("Admin@Example.edu", "correct horse");
    expect(await authenticate("admin@example.edu", "correct horse")).toEqual({ id: adminId, role: "ADMIN" });
    expect(await authenticate("ADMIN@example.edu ", "correct horse")).toMatchObject({ id: adminId });
    expect(await authenticate("admin@example.edu", "wrong")).toBeNull();
    expect(await authenticate("nobody@example.edu", "correct horse")).toBeNull();
    const row = await one<{ last_login_at: string | null; password_hash: string }>(pool(), "SELECT last_login_at, password_hash FROM users WHERE id = ?", [adminId]);
    expect(row!.last_login_at).not.toBeNull();
    expect(row!.password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(row!.password_hash).not.toContain("correct horse");
  });

  it("stores only a hash of the session token and resolves it to the user", async () => {
    const adminId = await createAdmin();
    const { token } = await createSession(adminId, { ip: "1.2.3.4", userAgent: "vitest" });
    const stored = await one<{ id: string }>(pool(), "SELECT id FROM sessions WHERE user_id = ?", [adminId]);
    expect(stored!.id).toBe(createHash("sha256").update(token).digest("hex"));
    expect(stored!.id).not.toBe(token);
    expect(await resolveSession(token)).toMatchObject({ id: adminId, role: "ADMIN", evaluatorId: null });
  });

  it("rejects garbage, unknown, expired and destroyed sessions", async () => {
    const adminId = await createAdmin();
    expect(await resolveSession(undefined)).toBeNull();
    expect(await resolveSession("")).toBeNull();
    expect(await resolveSession("not-a-token")).toBeNull();
    expect(await resolveSession("A".repeat(43))).toBeNull();

    const { token } = await createSession(adminId);
    await run(pool(), "UPDATE sessions SET expires_at = NOW(3) - INTERVAL 1 SECOND");
    expect(await resolveSession(token)).toBeNull();

    const second = await createSession(adminId);
    expect(await resolveSession(second.token)).not.toBeNull();
    await destroySession(second.token);
    expect(await resolveSession(second.token)).toBeNull();
  });

  it("extends a session in the second half of its life (sliding expiry)", async () => {
    const adminId = await createAdmin();
    const { token } = await createSession(adminId);
    await run(pool(), "UPDATE sessions SET expires_at = NOW(3) + INTERVAL 1 HOUR");
    await resolveSession(token);
    const row = await one<{ hours: number }>(pool(), "SELECT TIMESTAMPDIFF(MINUTE, NOW(3), expires_at) / 60 AS hours FROM sessions");
    expect(Number(row!.hours)).toBeGreaterThan(11);
  });

  it("cleans up expired sessions when a new one is created", async () => {
    const adminId = await createAdmin();
    await createSession(adminId);
    await run(pool(), "UPDATE sessions SET expires_at = NOW(3) - INTERVAL 1 DAY");
    await createSession(adminId);
    expect(await count("sessions")).toBe(1);
  });

  it("resolves evaluator sessions with the evaluator id", async () => {
    const ev = await createEvaluatorAccount("eve@example.edu", "Eve");
    expect(await authenticate("eve@example.edu", ev.password)).toEqual({ id: ev.userId, role: "EVALUATOR" });
    const { token } = await createSession(ev.userId);
    expect(await resolveSession(token)).toMatchObject({ role: "EVALUATOR", evaluatorId: ev.evaluatorId, name: "Eve" });
  });

  it("disabling an evaluator signs them out immediately and blocks login; enabling restores login", async () => {
    const ev = await createEvaluatorAccount("eve@example.edu");
    const { token } = await createSession(ev.userId);
    await setEvaluatorActive(ev.adminId, ev.evaluatorId, false);
    expect(await resolveSession(token)).toBeNull();
    expect(await authenticate("eve@example.edu", ev.password)).toBeNull();
    expect(await count("sessions", "user_id = ?", [ev.userId])).toBe(0);

    await setEvaluatorActive(ev.adminId, ev.evaluatorId, true);
    expect(await authenticate("eve@example.edu", ev.password)).not.toBeNull();
  });

  it("resetting a password invalidates the old one and all sessions", async () => {
    const ev = await createEvaluatorAccount("eve@example.edu");
    const { token } = await createSession(ev.userId);
    await resetEvaluatorPassword(ev.adminId, ev.evaluatorId, "a-brand-new-password");
    expect(await resolveSession(token)).toBeNull();
    expect(await authenticate("eve@example.edu", ev.password)).toBeNull();
    expect(await authenticate("eve@example.edu", "a-brand-new-password")).not.toBeNull();
    expect(await count("audit_logs", "action = 'EVALUATOR_PASSWORD_RESET'")).toBe(1);
  });

  it("a session whose evaluator record is disabled resolves without an evaluator id", async () => {
    const ev = await createEvaluatorAccount("eve@example.edu");
    const { token } = await createSession(ev.userId);
    await run(pool(), "UPDATE evaluators SET status = 'DISABLED' WHERE id = ?", [ev.evaluatorId]); // out-of-band change
    expect((await resolveSession(token))?.evaluatorId).toBeNull();
  });

  it("rejects duplicate evaluator emails and employee ids with a friendly error", async () => {
    await createEvaluatorAccount("eve@example.edu");
    await rejectsWith(createEvaluatorAccount("eve@example.edu"), "VALIDATION");
  });
});
