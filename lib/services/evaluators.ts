import "server-only";
import { hashPassword } from "@/lib/auth/password";
import { isMysqlError, one, pool, rows, run, uuid, withTransaction } from "@/lib/db/sql";
import { AppError } from "@/lib/errors";
import type { EvaluatorProgressRow } from "@/types/database";
import { writeAudit } from "./audit";
import { destroyUserSessions } from "./auth";
import { enqueueSync } from "./sync-queue";

export interface EvaluatorInput {
  name: string;
  email: string;
  employeeId: string | null;
  department: string | null;
}

const IN_USE = "Email or employee ID already in use.";

/** Creates the login (users) and the evaluator record together. */
export async function createEvaluator(adminId: string, input: EvaluatorInput & { password: string }) {
  const userId = uuid();
  const evaluatorId = uuid();
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  try {
    await withTransaction(async (tx) => {
      await run(tx, "INSERT INTO users (id, email, password_hash, role, full_name) VALUES (?, ?, ?, 'EVALUATOR', ?)", [
        userId,
        email,
        passwordHash,
        input.name,
      ]);
      await run(
        tx,
        "INSERT INTO evaluators (id, user_id, name, email, employee_id, department) VALUES (?, ?, ?, ?, ?, ?)",
        [evaluatorId, userId, input.name, email, input.employeeId, input.department],
      );
      await writeAudit(tx, { userId: adminId, action: "EVALUATOR_CREATED", entityType: "evaluator", entityId: evaluatorId, metadata: { email } });
      await enqueueSync(tx, "EVALUATOR", evaluatorId);
    });
  } catch (error) {
    if (isMysqlError(error, "ER_DUP_ENTRY")) throw new AppError("VALIDATION", IN_USE);
    throw error;
  }
  return evaluatorId;
}

export async function updateEvaluator(adminId: string, id: string, input: EvaluatorInput) {
  const email = input.email.trim().toLowerCase();
  try {
    await withTransaction(async (tx) => {
      const existing = await one<{ user_id: string | null }>(tx, "SELECT user_id FROM evaluators WHERE id = ? FOR UPDATE", [id]);
      if (!existing) throw new AppError("VALIDATION", "Evaluator not found.");
      await run(tx, "UPDATE evaluators SET name = ?, email = ?, employee_id = ?, department = ? WHERE id = ?", [
        input.name,
        email,
        input.employeeId,
        input.department,
        id,
      ]);
      if (existing.user_id) {
        await run(tx, "UPDATE users SET email = ?, full_name = ? WHERE id = ?", [email, input.name, existing.user_id]);
      }
      await writeAudit(tx, { userId: adminId, action: "EVALUATOR_UPDATED", entityType: "evaluator", entityId: id });
      await enqueueSync(tx, "EVALUATOR", id);
    });
  } catch (error) {
    if (isMysqlError(error, "ER_DUP_ENTRY")) throw new AppError("VALIDATION", IN_USE);
    throw error;
  }
}

/** Disabling signs the evaluator out everywhere immediately and blocks login. */
export async function setEvaluatorActive(adminId: string, id: string, active: boolean) {
  await withTransaction(async (tx) => {
    const evaluator = await one<{ user_id: string | null }>(tx, "SELECT user_id FROM evaluators WHERE id = ? FOR UPDATE", [id]);
    if (!evaluator) throw new AppError("VALIDATION", "Evaluator not found.");
    await run(tx, "UPDATE evaluators SET status = ? WHERE id = ?", [active ? "ACTIVE" : "DISABLED", id]);
    if (evaluator.user_id) {
      await run(tx, "UPDATE users SET is_active = ? WHERE id = ?", [active ? 1 : 0, evaluator.user_id]);
      if (!active) await destroyUserSessions(evaluator.user_id, tx);
    }
    await writeAudit(tx, { userId: adminId, action: active ? "EVALUATOR_ENABLED" : "EVALUATOR_DISABLED", entityType: "evaluator", entityId: id });
    await enqueueSync(tx, "EVALUATOR", id);
  });
}

export async function resetEvaluatorPassword(adminId: string, id: string, password: string) {
  const hash = await hashPassword(password);
  await withTransaction(async (tx) => {
    const evaluator = await one<{ user_id: string | null }>(tx, "SELECT user_id FROM evaluators WHERE id = ?", [id]);
    if (!evaluator?.user_id) throw new AppError("VALIDATION", "Evaluator has no login.");
    await run(tx, "UPDATE users SET password_hash = ? WHERE id = ?", [hash, evaluator.user_id]);
    await destroyUserSessions(evaluator.user_id, tx);
    await writeAudit(tx, { userId: adminId, action: "EVALUATOR_PASSWORD_RESET", entityType: "evaluator", entityId: id });
  });
}

const PROGRESS_SQL = `
  SELECT e.id AS evaluator_id, e.name, e.email, e.employee_id, e.department, e.status,
         COUNT(ev.id)                                         AS claimed_count,
         COALESCE(SUM(ev.status = 'COMPLETED'), 0)            AS completed_count,
         COALESCE(SUM(ev.status = 'IN_PROGRESS'), 0)          AS in_progress_count,
         ROUND(AVG(CASE WHEN ev.status = 'COMPLETED' AND ev.max_total > 0
                        THEN 100 * ev.total_score / ev.max_total END), 1) AS average_percentage
    FROM evaluators e
    LEFT JOIN evaluations ev ON ev.evaluator_id = e.id`;

const normalizeProgress = (r: EvaluatorProgressRow): EvaluatorProgressRow => ({
  ...r,
  claimed_count: Number(r.claimed_count),
  completed_count: Number(r.completed_count),
  in_progress_count: Number(r.in_progress_count),
  average_percentage: r.average_percentage === null ? null : Number(r.average_percentage),
});

export async function listEvaluatorProgress(ids?: readonly string[]): Promise<EvaluatorProgressRow[]> {
  if (ids && ids.length === 0) return [];
  const list = ids
    ? await rows<EvaluatorProgressRow>(pool(), `${PROGRESS_SQL} WHERE e.id IN (?) GROUP BY e.id ORDER BY e.name`, [ids])
    : await rows<EvaluatorProgressRow>(pool(), `${PROGRESS_SQL} GROUP BY e.id ORDER BY e.name`);
  return list.map(normalizeProgress);
}

export const listEvaluatorOptions = () =>
  rows<{ id: string; name: string; status: "ACTIVE" | "DISABLED" }>(pool(), "SELECT id, name, status FROM evaluators ORDER BY name");
