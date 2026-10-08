import { z } from "zod";
import { isTieBreakerId } from "@/lib/results/ranking";

export const uuidSchema = z.uuid();

/** Score must be an integer 1–10. Strings like "7" are accepted from forms; "7.5" is not. */
export const scoreSchema = z.coerce
  .number({ error: "Score is required" })
  .int("Score must be a whole number")
  .min(1, "Score must be at least 1")
  .max(10, "Score must be at most 10");

export const remarksSchema = z
  .string()
  .trim()
  .max(5000, "Remarks must be 5000 characters or fewer")
  .optional()
  .transform((v) => (v ? v : null));

export const submitEvaluationSchema = z.object({
  assignmentId: uuidSchema,
  score: scoreSchema,
  remarks: remarksSchema,
});

export const saveDraftSchema = z.object({
  assignmentId: uuidSchema,
  score: scoreSchema.nullable(),
  remarks: remarksSchema,
});

export const loginSchema = z.object({
  email: z.email("Enter a valid email").trim().toLowerCase(),
  password: z.string().min(1, "Password is required").max(200),
});

export const evaluatorSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(120),
  email: z.email("Enter a valid email").trim().toLowerCase(),
  employeeId: z
    .string()
    .trim()
    .max(50)
    .optional()
    .transform((v) => v || null),
  department: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((v) => v || null),
  maxAssignments: z.coerce.number().int().min(1).max(1000).default(50),
});

export const createEvaluatorSchema = evaluatorSchema.extend({
  password: z.string().min(8, "Password must be at least 8 characters").max(72),
});

export const updateEvaluatorSchema = evaluatorSchema.extend({ id: uuidSchema });

export const eventStatusSchema = z.enum(["NOT_STARTED", "LIVE", "PAUSED", "CLOSED"]);
export type EventStatus = z.infer<typeof eventStatusSchema>;

export const allocationConfigSchema = z.object({
  type: z.enum(["INITIAL", "INCREMENTAL", "FULL_REALLOCATION"]),
  maxPerEvaluator: z.coerce.number().int().min(1).max(1000),
  evaluatorsPerStudent: z.coerce.number().int().min(1).max(5),
});

export const confirmAllocationSchema = allocationConfigSchema.extend({
  seed: z.string().regex(/^[a-f0-9]{64}$/, "Invalid seed"),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/, "Invalid fingerprint"),
});

export const settingsSchema = z.object({
  allowResubmission: z.coerce.boolean(),
  tieBreakers: z
    .array(z.string())
    .max(5)
    .refine((ids) => ids.every(isTieBreakerId), "Unknown tie-breaker")
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate tie-breaker"),
});

export const csvImportRowSchema = z.record(z.string(), z.string());
