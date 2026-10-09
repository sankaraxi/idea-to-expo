/**
 * Centralised error handling. Services throw AppError with a stable code;
 * everything user-facing goes through `toFailure` so internals (SQL, stack
 * traces) never reach the browser.
 */

export const ERROR_MESSAGES = {
  NOT_AN_EVALUATOR: "Your evaluator account is not active. Please contact the event admin.",
  EVENT_NOT_LIVE: "Evaluation is not open right now. Your work is saved on this device — you can submit once the event is live.",
  INVALID_SCORE: "Scores must be whole numbers.",
  SCORE_OUT_OF_RANGE: "A score is above that criterion's maximum.",
  INCOMPLETE_SCORES: "Please score every criterion before submitting.",
  UNKNOWN_CRITERION: "The evaluation criteria changed. Please reload the page.",
  UNKNOWN_DOMAIN: "The domain list changed. Please reload the page.",
  NO_CRITERIA: "No evaluation criteria are set up yet. Please contact the event admin.",
  DECISION_REQUIRED: "Choose a status: Selected, Waitlisted or Rejected.",
  INVALID_DECISION: "Status must be Selected, Waitlisted or Rejected.",
  REMARKS_TOO_LONG: "Remarks must be 5000 characters or fewer.",
  STUDENT_NOT_FOUND: "Student not found.",
  STUDENT_TAKEN: "This student is already being evaluated by another evaluator.",
  ALREADY_SUBMITTED: "This evaluation has already been submitted and can no longer be changed.",
  FORBIDDEN: "You do not have permission to do that.",
  REASON_REQUIRED: "Please give a reason.",
  EVALUATION_NOT_FOUND: "Evaluation not found.",
  EVALUATION_NOT_COMPLETED: "Only submitted evaluations can be reopened.",
  INVALID_EVENT_STATUS: "Unknown event status.",
  CRITERION_IN_USE: "This criterion already has scores. Deactivate it instead, or keep its maximum at or above the highest score given.",
  DOMAIN_IN_USE: "This domain is used by evaluations. Deactivate it instead.",
  UNAUTHENTICATED: "Your session has expired. Please sign in again.",
  RATE_LIMITED: "Too many attempts. Please wait a moment and try again.",
  VALIDATION: "Some fields are invalid. Please check and try again.",
  DB_UNAVAILABLE: "The database is not reachable right now. Your draft is saved on this device — please try again in a moment.",
  NETWORK: "Could not reach the server. Check your connection and try again.",
  UNKNOWN: "Something went wrong. Please try again.",
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = "AppError";
  }
}

export type ActionResult<T = void> =
  | ({ ok: true } & (T extends void ? { data?: undefined } : { data: T }))
  | { ok: false; code: ErrorCode; message: string; fieldErrors?: Record<string, string[]> };

export function ok(): ActionResult<void>;
export function ok<T>(data: T): ActionResult<T>;
export function ok<T>(data?: T) {
  return { ok: true, data } as ActionResult<T>;
}

export function fail(code: ErrorCode, message?: string, fieldErrors?: Record<string, string[]>) {
  return { ok: false as const, code, message: message ?? ERROR_MESSAGES[code], fieldErrors };
}

const CONNECTION_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "PROTOCOL_CONNECTION_LOST",
  "ER_CON_COUNT_ERROR",
  "ER_SERVER_SHUTDOWN",
  "ER_ACCESS_DENIED_ERROR",
  "ER_BAD_DB_ERROR",
]);

/** True for failures to reach/log into the database (as opposed to a bad query or data). */
export function isDatabaseUnavailable(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;
  if (code && CONNECTION_ERRORS.has(code)) return true;
  // mysql2 wraps pool failures in an AggregateError for multi-address hosts (e.g. localhost).
  if (error instanceof AggregateError) return error.errors.some(isDatabaseUnavailable);
  return false;
}

export function errorCodeOf(error: unknown): ErrorCode | null {
  if (error instanceof AppError) return error.code;
  if (isDatabaseUnavailable(error)) return "DB_UNAVAILABLE";
  return null;
}

/** Converts any thrown value into a safe ActionResult failure, logging the internals server-side. */
export function toFailure(error: unknown, context: string) {
  if (error instanceof AppError) return fail(error.code, error.message);
  console.error(`[${context}]`, error);
  return fail(isDatabaseUnavailable(error) ? "DB_UNAVAILABLE" : "UNKNOWN");
}
