/**
 * Centralised error handling. Database functions raise stable codes as the
 * exception message; everything user-facing goes through `toUserMessage` so
 * internals (SQL, stack traces) never reach the browser.
 */

export const ERROR_MESSAGES = {
  NOT_AN_EVALUATOR: "Your evaluator account is not active. Please contact the event admin.",
  EVENT_NOT_LIVE: "Evaluation is not open right now. Your work is saved — you can submit once the event is live.",
  INVALID_SCORE: "Score must be a whole number from 1 to 10.",
  REMARKS_TOO_LONG: "Remarks must be 5000 characters or fewer.",
  ASSIGNMENT_NOT_FOUND: "This student is not assigned to you.",
  ALREADY_SUBMITTED: "This evaluation has already been submitted and can no longer be changed.",
  FORBIDDEN: "You do not have permission to do that.",
  REASON_REQUIRED: "Please give a reason.",
  EVALUATION_NOT_FOUND: "Evaluation not found.",
  EVALUATION_NOT_COMPLETED: "Only submitted evaluations can be reopened.",
  INVALID_EVENT_STATUS: "Unknown event status.",
  INVALID_ALLOCATION_TYPE: "Unknown allocation type.",
  INVALID_ALLOCATION_CONFIG: "Allocation settings are out of range.",
  EMPTY_ALLOCATION: "There is nothing to allocate.",
  STALE_PREVIEW: "Students or evaluators changed since this preview was generated. Please regenerate the allocation.",
  CAPACITY_EXCEEDED: "Allocation would exceed evaluator capacity. Please regenerate the allocation.",
  UNAUTHENTICATED: "Your session has expired. Please sign in again.",
  RATE_LIMITED: "Too many attempts. Please wait a moment and try again.",
  VALIDATION: "Some fields are invalid. Please check and try again.",
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

function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_MESSAGES, value);
}

/** Extracts a known code from a Supabase/PostgREST/Postgres error, if any. */
export function errorCodeOf(error: unknown): ErrorCode | null {
  if (error instanceof AppError) return error.code;
  if (error && typeof error === "object") {
    const message = "message" in error ? String((error as { message: unknown }).message) : "";
    const head = message.split(/[\s:]/)[0];
    if (isErrorCode(head)) return head;
    const pgCode = "code" in error ? String((error as { code: unknown }).code) : "";
    if (pgCode === "42501") return "FORBIDDEN";
    if (pgCode === "PGRST301" || pgCode === "401") return "UNAUTHENTICATED";
    if (/fetch failed|network|ECONNREFUSED|ETIMEDOUT/i.test(message)) return "NETWORK";
  }
  return null;
}

/** Converts any thrown value into a safe ActionResult failure, logging the internals server-side. */
export function toFailure(error: unknown, context: string) {
  const code = errorCodeOf(error);
  if (!code || code === "UNKNOWN" || code === "NETWORK") {
    console.error(`[${context}]`, error);
  }
  const detail =
    error && typeof error === "object" && "details" in error && code === "STALE_PREVIEW"
      ? String((error as { details: unknown }).details ?? "")
      : "";
  const base = ERROR_MESSAGES[code ?? "UNKNOWN"];
  return fail(code ?? "UNKNOWN", detail ? `${base} (${detail})` : base);
}
