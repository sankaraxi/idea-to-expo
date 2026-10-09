import "server-only";
import { isDecision, type Decision } from "@/lib/decision";
import { isMysqlError, one, pool, rows, run, uuid, withTransaction, escapeLike, type Queryable } from "@/lib/db/sql";
import { AppError } from "@/lib/errors";
import type {
  ClaimStatus,
  CriterionRow,
  EvaluationRow,
  EventStatus,
  MyEvaluationRow,
  SearchResultRow,
  StudentForEvaluation,
} from "@/types/database";
import { writeAudit } from "./audit";
import { enqueueSync, RESULTS_KEY } from "./sync-queue";

/**
 * Evaluator-side logic. There is no database-level row security, so:
 *   - every function takes the evaluatorId from the authenticated session
 *     (lib/auth/session.ts) — it is never derived from request input;
 *   - every read of another evaluator's data is simply not offered: search and
 *     detail only reveal "taken", never who has the student or their scores.
 *
 * Concurrency: claiming locks the student row (SELECT … FOR UPDATE), and
 * evaluations.student_id is UNIQUE as a backstop, so two evaluators can never
 * both own a student. There is no per-evaluator limit.
 */

const MAX_REMARKS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EvaluationInput {
  studentId: string;
  scores: Record<string, unknown>;
  remarks: string | null;
  /** Selected / Waitlisted / Rejected — optional on drafts, required on submit. */
  decision?: string | null;
  domainIds: string[];
}

function normalizeRemarks(value: string | null | undefined) {
  const text = (value ?? "").trim();
  if (text.length > MAX_REMARKS) throw new AppError("REMARKS_TOO_LONG");
  return text === "" ? null : text;
}

function normalizeDecision(value: string | null | undefined): Decision | null {
  if (value === null || value === undefined || value === "") return null;
  if (!isDecision(value)) throw new AppError("INVALID_DECISION");
  return value;
}

/** Scores keyed by criterion id → whole numbers within 0..max for ACTIVE criteria. */
export function validateScores(criteria: readonly CriterionRow[], scores: Record<string, unknown>, requireAll: boolean) {
  const byId = new Map(criteria.map((c) => [c.id, c]));
  const out = new Map<string, number>();
  for (const [key, value] of Object.entries(scores ?? {})) {
    if (value === null || value === undefined) continue;
    const criterion = UUID.test(key) ? byId.get(key.toLowerCase()) : undefined;
    if (!criterion) throw new AppError("UNKNOWN_CRITERION");
    if (typeof value !== "number" || !Number.isInteger(value)) throw new AppError("INVALID_SCORE");
    if (value < 0 || value > criterion.max_marks) {
      throw new AppError("SCORE_OUT_OF_RANGE", `The score for “${criterion.name}” must be between 0 and ${criterion.max_marks}.`);
    }
    out.set(criterion.id, value);
  }
  if (requireAll) {
    if (criteria.length === 0) throw new AppError("NO_CRITERIA");
    if (criteria.some((c) => !out.has(c.id))) throw new AppError("INCOMPLETE_SCORES");
  }
  return out;
}

async function validateDomains(tx: Queryable, ids: readonly string[]) {
  const unique = [...new Set(ids ?? [])];
  if (unique.length === 0) return unique;
  const found = await rows<{ id: string }>(tx, "SELECT id FROM domains WHERE id IN (?) AND is_active = 1", [unique]);
  if (found.length !== unique.length) throw new AppError("UNKNOWN_DOMAIN");
  return unique;
}

async function readSettings(tx: Queryable) {
  const row = await one<{ event_status: EventStatus; allow_resubmission: boolean }>(
    tx,
    "SELECT event_status, allow_resubmission FROM app_settings WHERE id = 1",
  );
  if (!row) throw new Error("app_settings row is missing — import database/idea_to_expo.sql");
  return row;
}

/** Returns the evaluator's login id (for the audit trail). */
async function assertActiveEvaluator(tx: Queryable, evaluatorId: string) {
  const evaluator = await one<{ status: string; user_id: string | null }>(tx, "SELECT status, user_id FROM evaluators WHERE id = ?", [evaluatorId]);
  if (evaluator?.status !== "ACTIVE") throw new AppError("NOT_AN_EVALUATOR");
  return evaluator.user_id;
}

/** Returns the caller's evaluation for the student, creating (claiming) it if the student is free. */
async function claim(tx: Queryable, evaluatorId: string, studentId: string): Promise<EvaluationRow> {
  const student = await one(tx, "SELECT id FROM students WHERE id = ? AND status = 'ACTIVE' FOR UPDATE", [studentId]);
  if (!student) throw new AppError("STUDENT_NOT_FOUND");

  const existing = await one<EvaluationRow>(tx, "SELECT * FROM evaluations WHERE student_id = ? FOR UPDATE", [studentId]);
  if (existing) {
    if (existing.evaluator_id !== evaluatorId) throw new AppError("STUDENT_TAKEN");
    return existing;
  }

  const id = uuid();
  try {
    await run(tx, "INSERT INTO evaluations (id, student_id, evaluator_id, status) VALUES (?, ?, ?, 'IN_PROGRESS')", [id, studentId, evaluatorId]);
  } catch (error) {
    if (isMysqlError(error, "ER_DUP_ENTRY")) throw new AppError("STUDENT_TAKEN");
    throw error;
  }
  await enqueueSync(tx, "EVALUATOR", evaluatorId);
  await enqueueSync(tx, "STUDENT", studentId);
  return (await one<EvaluationRow>(tx, "SELECT * FROM evaluations WHERE id = ?", [id]))!;
}

async function replaceScoresAndDomains(tx: Queryable, evaluationId: string, scores: Map<string, number>, domainIds: readonly string[]) {
  await run(tx, "DELETE FROM evaluation_scores WHERE evaluation_id = ?", [evaluationId]);
  if (scores.size > 0) {
    await run(tx, "INSERT INTO evaluation_scores (evaluation_id, criterion_id, score) VALUES ?", [
      [...scores].map(([criterionId, score]) => [evaluationId, criterionId, score]),
    ]);
  }
  await run(tx, "DELETE FROM evaluation_domains WHERE evaluation_id = ?", [evaluationId]);
  if (domainIds.length > 0) {
    await run(tx, "INSERT INTO evaluation_domains (evaluation_id, domain_id) VALUES ?", [domainIds.map((d) => [evaluationId, d])]);
  }
}

const sum = (values: Iterable<number>) => [...values].reduce((a, b) => a + b, 0);

const activeCriteria = (tx: Queryable) =>
  rows<CriterionRow>(tx, "SELECT * FROM evaluation_criteria WHERE is_active = 1 ORDER BY sort_order, name");

// ---------------------------------------------------------------------------
// Draft + submit
// ---------------------------------------------------------------------------

export async function saveDraft(evaluatorId: string, input: EvaluationInput) {
  return withTransaction(async (tx) => {
    await assertActiveEvaluator(tx, evaluatorId);
    const settings = await readSettings(tx);
    if (settings.event_status !== "LIVE" && settings.event_status !== "PAUSED") throw new AppError("EVENT_NOT_LIVE");
    const remarks = normalizeRemarks(input.remarks);
    const decision = normalizeDecision(input.decision);
    const criteria = await activeCriteria(tx);
    const scores = validateScores(criteria, input.scores, false);
    const domains = await validateDomains(tx, input.domainIds);

    const evaluation = await claim(tx, evaluatorId, input.studentId);
    if (evaluation.status === "COMPLETED") throw new AppError("ALREADY_SUBMITTED");

    await replaceScoresAndDomains(tx, evaluation.id, scores, domains);
    await run(
      tx,
      "UPDATE evaluations SET remarks = ?, decision = ?, version = version + 1, total_score = ?, max_total = ? WHERE id = ?",
      [remarks, decision, sum(scores.values()), sum(criteria.map((c) => c.max_marks)), evaluation.id],
    );
    const saved = (await one<EvaluationRow>(tx, "SELECT * FROM evaluations WHERE id = ?", [evaluation.id]))!;
    return { evaluationId: saved.id, version: saved.version, savedAt: saved.updated_at };
  });
}

export async function submitEvaluation(evaluatorId: string, input: EvaluationInput) {
  return withTransaction(async (tx) => {
    const actorUserId = await assertActiveEvaluator(tx, evaluatorId);
    const settings = await readSettings(tx);
    if (settings.event_status !== "LIVE") throw new AppError("EVENT_NOT_LIVE");
    const remarks = normalizeRemarks(input.remarks);
    const decision = normalizeDecision(input.decision);
    const criteria = await activeCriteria(tx);
    const scores = validateScores(criteria, input.scores, true);
    if (!decision) throw new AppError("DECISION_REQUIRED");
    const domains = await validateDomains(tx, input.domainIds);
    const total = sum(scores.values());
    const maxTotal = sum(criteria.map((c) => c.max_marks));

    const evaluation = await claim(tx, evaluatorId, input.studentId);
    let action = "EVALUATION_SUBMITTED";

    if (evaluation.status === "COMPLETED") {
      const oldScores = await rows<{ criterion_id: string; score: number }>(tx, "SELECT criterion_id, score FROM evaluation_scores WHERE evaluation_id = ?", [evaluation.id]);
      const oldDomains = await rows<{ domain_id: string }>(tx, "SELECT domain_id FROM evaluation_domains WHERE evaluation_id = ?", [evaluation.id]);
      const sameScores = oldScores.length === scores.size && oldScores.every((s) => scores.get(s.criterion_id) === s.score);
      const sameDomains = oldDomains.length === domains.length && oldDomains.every((d) => domains.includes(d.domain_id));
      // Identical payload again (double click / retry after a timeout): succeed quietly.
      if (sameScores && sameDomains && evaluation.remarks === remarks && evaluation.decision === decision) {
        return {
          evaluationId: evaluation.id,
          submittedAt: evaluation.submitted_at!,
          totalScore: evaluation.total_score!,
          maxTotal: evaluation.max_total!,
          duplicate: true,
        };
      }
      if (!settings.allow_resubmission) throw new AppError("ALREADY_SUBMITTED");
      action = "EVALUATION_UPDATED";
    }

    await replaceScoresAndDomains(tx, evaluation.id, scores, domains);
    await run(
      tx,
      `UPDATE evaluations
          SET remarks = ?, decision = ?, status = 'COMPLETED', total_score = ?, max_total = ?, submitted_at = NOW(3), version = version + 1
        WHERE id = ?`,
      [remarks, decision, total, maxTotal, evaluation.id],
    );
    const saved = (await one<EvaluationRow>(tx, "SELECT * FROM evaluations WHERE id = ?", [evaluation.id]))!;

    await writeAudit(tx, {
      userId: actorUserId,
      action,
      entityType: "evaluation",
      entityId: evaluation.id,
      metadata: {
        student_id: input.studentId,
        evaluator_id: evaluatorId,
        scores: Object.fromEntries(scores),
        total,
        max_total: maxTotal,
        decision,
        domains,
      },
    });
    await afterEvaluationChange(tx, saved);
    return { evaluationId: saved.id, submittedAt: saved.submitted_at!, totalScore: total, maxTotal, duplicate: false };
  });
}

/** Everything that reports a completed evaluation to Google Sheets. */
async function afterEvaluationChange(tx: Queryable, evaluation: Pick<EvaluationRow, "id" | "student_id" | "evaluator_id">) {
  await enqueueSync(tx, "EVALUATION", evaluation.id);
  await enqueueSync(tx, "RESPONSE_ROW", evaluation.student_id);
  await enqueueSync(tx, "RESULTS", RESULTS_KEY);
  await enqueueSync(tx, "EVALUATOR", evaluation.evaluator_id);
  await enqueueSync(tx, "STUDENT", evaluation.student_id);
}

/** Evaluator gives back a student they started but have not submitted. */
export async function releaseMyEvaluation(evaluatorId: string, studentId: string) {
  await withTransaction(async (tx) => {
    const actorUserId = await assertActiveEvaluator(tx, evaluatorId);
    const evaluation = await one<EvaluationRow>(
      tx,
      "SELECT * FROM evaluations WHERE student_id = ? AND evaluator_id = ? FOR UPDATE",
      [studentId, evaluatorId],
    );
    if (!evaluation) throw new AppError("EVALUATION_NOT_FOUND");
    if (evaluation.status === "COMPLETED") throw new AppError("ALREADY_SUBMITTED");
    await run(tx, "DELETE FROM evaluations WHERE id = ?", [evaluation.id]);
    await writeAudit(tx, { userId: actorUserId, action: "EVALUATION_RELEASED", entityType: "evaluation", entityId: evaluation.id, metadata: { student_id: studentId, evaluator_id: evaluatorId, by: "evaluator" } });
    await enqueueSync(tx, "EVALUATOR", evaluatorId);
    await enqueueSync(tx, "STUDENT", studentId);
  });
}

// ---------------------------------------------------------------------------
// Admin corrections (admins never edit scores)
// ---------------------------------------------------------------------------

function requireReason(reason: string) {
  if (reason.trim() === "") throw new AppError("REASON_REQUIRED");
  return reason.trim();
}

export async function adminReopenEvaluation(adminId: string, evaluationId: string, reason: string) {
  const why = requireReason(reason);
  await withTransaction(async (tx) => {
    const evaluation = await one<EvaluationRow>(tx, "SELECT * FROM evaluations WHERE id = ? FOR UPDATE", [evaluationId]);
    if (!evaluation) throw new AppError("EVALUATION_NOT_FOUND");
    if (evaluation.status !== "COMPLETED") throw new AppError("EVALUATION_NOT_COMPLETED");
    await run(tx, "UPDATE evaluations SET status = 'IN_PROGRESS', submitted_at = NULL, version = version + 1 WHERE id = ?", [evaluationId]);
    await writeAudit(tx, {
      userId: adminId,
      action: "EVALUATION_REOPENED",
      entityType: "evaluation",
      entityId: evaluationId,
      metadata: { reason: why, previous_total: evaluation.total_score, previous_decision: evaluation.decision, evaluator_id: evaluation.evaluator_id },
    });
    await afterEvaluationChange(tx, evaluation);
  });
}

/** Frees the student for any evaluator. The scores survive in the audit log. */
export async function adminReleaseEvaluation(adminId: string, evaluationId: string, reason: string) {
  const why = requireReason(reason);
  await withTransaction(async (tx) => {
    const evaluation = await one<EvaluationRow>(tx, "SELECT * FROM evaluations WHERE id = ? FOR UPDATE", [evaluationId]);
    if (!evaluation) throw new AppError("EVALUATION_NOT_FOUND");
    const scores = await rows<{ criterion_id: string; score: number }>(tx, "SELECT criterion_id, score FROM evaluation_scores WHERE evaluation_id = ?", [evaluationId]);
    await run(tx, "DELETE FROM evaluations WHERE id = ?", [evaluationId]);
    await writeAudit(tx, {
      userId: adminId,
      action: "EVALUATION_RELEASED",
      entityType: "evaluation",
      entityId: evaluationId,
      metadata: {
        reason: why,
        by: "admin",
        student_id: evaluation.student_id,
        evaluator_id: evaluation.evaluator_id,
        status: evaluation.status,
        decision: evaluation.decision,
        total: evaluation.total_score,
        remarks: evaluation.remarks,
        scores: Object.fromEntries(scores.map((s) => [s.criterion_id, s.score])),
      },
    });
    await afterEvaluationChange(tx, evaluation); // worker blanks the sheet row once the evaluation is gone
  });
}

// ---------------------------------------------------------------------------
// Evaluator reads
// ---------------------------------------------------------------------------

const CLAIM_SQL = `CASE
  WHEN ev.id IS NULL THEN 'AVAILABLE'
  WHEN ev.evaluator_id = ? AND ev.status = 'COMPLETED' THEN 'MINE_COMPLETED'
  WHEN ev.evaluator_id = ? THEN 'MINE_IN_PROGRESS'
  ELSE 'TAKEN' END`;

/** Search by register number / email (prefix) or name (contains). Reveals only whether a student is taken. */
export async function searchStudents(evaluatorId: string, query: string, limit = 20): Promise<SearchResultRow[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const registerNumber = q.replace(/\s/g, "").toUpperCase();
  return rows<SearchResultRow>(
    pool(),
    `SELECT s.id AS student_id, s.register_number, s.name, s.department, s.section, s.email,
            COALESCE(i.submission_status, 'MISSING') AS submission_status,
            ${CLAIM_SQL} AS claim_status
       FROM students s
       LEFT JOIN ideas i ON i.student_id = s.id
       LEFT JOIN evaluations ev ON ev.student_id = s.id
      WHERE s.status = 'ACTIVE'
        AND (s.register_number LIKE CONCAT(?, '%')
             OR s.name LIKE CONCAT('%', ?, '%')
             OR s.email LIKE CONCAT(?, '%'))
      ORDER BY (s.register_number = ?) DESC, s.register_number
      LIMIT ?`,
    [evaluatorId, evaluatorId, escapeLike(registerNumber), escapeLike(q), escapeLike(q), registerNumber, Math.min(Math.max(limit, 1), 50)],
  );
}

/** Student + submission for the evaluation screen. Other evaluators' evaluations are never returned. */
export async function getStudentForEvaluation(evaluatorId: string, studentId: string): Promise<StudentForEvaluation | null> {
  const student = await one<StudentForEvaluation["student"]>(
    pool(),
    "SELECT id, register_number, name, department, section, year, email FROM students WHERE id = ? AND status = 'ACTIVE'",
    [studentId],
  );
  if (!student) return null;
  const [idea, evaluation] = await Promise.all([
    one<NonNullable<StudentForEvaluation["idea"]>>(
      pool(),
      "SELECT problem_statement, abstract, ppt_url, other_details, submission_status, submitted_at FROM ideas WHERE student_id = ?",
      [studentId],
    ),
    one<EvaluationRow>(pool(), "SELECT * FROM evaluations WHERE student_id = ?", [studentId]),
  ]);

  const mine = evaluation?.evaluator_id === evaluatorId;
  const claim: ClaimStatus = !evaluation
    ? "AVAILABLE"
    : !mine
      ? "TAKEN"
      : evaluation.status === "COMPLETED"
        ? "MINE_COMPLETED"
        : "MINE_IN_PROGRESS";

  let mineDetail: StudentForEvaluation["evaluation"] = null;
  if (evaluation && mine) {
    const [scores, domains] = await Promise.all([
      rows<{ criterion_id: string; score: number }>(pool(), "SELECT criterion_id, score FROM evaluation_scores WHERE evaluation_id = ?", [evaluation.id]),
      rows<{ domain_id: string }>(pool(), "SELECT domain_id FROM evaluation_domains WHERE evaluation_id = ?", [evaluation.id]),
    ]);
    mineDetail = {
      id: evaluation.id,
      status: evaluation.status,
      remarks: evaluation.remarks,
      decision: evaluation.decision,
      version: evaluation.version,
      updated_at: evaluation.updated_at,
      submitted_at: evaluation.submitted_at,
      total_score: evaluation.total_score,
      max_total: evaluation.max_total,
      scores: Object.fromEntries(scores.map((s) => [s.criterion_id, s.score])),
      domain_ids: domains.map((d) => d.domain_id),
    };
  }
  return { student, idea, claim_status: claim, evaluation: mineDetail };
}

export const listMyEvaluations = (evaluatorId: string) =>
  rows<MyEvaluationRow>(
    pool(),
    `SELECT ev.id AS evaluation_id, ev.status, ev.decision, ev.total_score, ev.max_total, ev.started_at, ev.submitted_at, ev.updated_at,
            s.id AS student_id, s.register_number, s.name AS student_name, s.department, s.section
       FROM evaluations ev JOIN students s ON s.id = ev.student_id
      WHERE ev.evaluator_id = ?
      ORDER BY ev.updated_at DESC
      LIMIT 5000`,
    [evaluatorId],
  );

/** Counts only (no student data): how the evaluator and the whole event are doing. */
export async function getEvaluatorStats(evaluatorId: string) {
  const [mine, event] = await Promise.all([
    one<{ completed: number; in_progress: number }>(
      pool(),
      `SELECT COALESCE(SUM(status = 'COMPLETED'), 0) AS completed, COALESCE(SUM(status = 'IN_PROGRESS'), 0) AS in_progress
         FROM evaluations WHERE evaluator_id = ?`,
      [evaluatorId],
    ),
    one<{ total: number; claimed: number; completed: number }>(
      pool(),
      `SELECT (SELECT COUNT(*) FROM students WHERE status = 'ACTIVE') AS total,
              (SELECT COUNT(*) FROM evaluations) AS claimed,
              (SELECT COUNT(*) FROM evaluations WHERE status = 'COMPLETED') AS completed`,
    ),
  ]);
  const total = Number(event?.total ?? 0);
  const completedAll = Number(event?.completed ?? 0);
  return {
    completed: Number(mine?.completed ?? 0),
    inProgress: Number(mine?.in_progress ?? 0),
    unclaimedStudents: Math.max(0, total - Number(event?.claimed ?? 0)),
    eventTotal: total,
    eventCompleted: completedAll,
    eventPercent: total === 0 ? 0 : Math.round((completedAll / total) * 100),
  };
}

