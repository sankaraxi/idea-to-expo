import { z } from "zod";
import { DECISIONS } from "@/lib/decision";
import { isTieBreakerId } from "@/lib/results/ranking";

export const uuidSchema = z.uuid();

export const remarksSchema = z
  .string()
  .trim()
  .max(5000, "Remarks must be 5000 characters or fewer")
  .optional()
  .transform((v) => (v ? v : null));

/** {criterionId: integer}. Range against each criterion's max is enforced in the database. */
export const scoresSchema = z.record(
  z.uuid(),
  z.number().int("Scores must be whole numbers").min(0, "Scores cannot be negative").max(100),
);

export const evaluationInputSchema = z.object({
  studentId: uuidSchema,
  scores: scoresSchema,
  remarks: remarksSchema,
  /** Selected / Waitlisted / Rejected. Optional for drafts; required to submit (enforced in the service). */
  decision: z.enum(DECISIONS).nullable().default(null),
  domainIds: z.array(z.uuid()).max(20).default([]),
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
});

export const createEvaluatorSchema = evaluatorSchema.extend({
  password: z.string().min(8, "Password must be at least 8 characters").max(72),
});

export const updateEvaluatorSchema = evaluatorSchema.extend({ id: uuidSchema });

export const eventStatusSchema = z.enum(["NOT_STARTED", "LIVE", "PAUSED", "CLOSED"]);
export type EventStatus = z.infer<typeof eventStatusSchema>;

export const criterionSchema = z
  .object({
    id: uuidSchema.optional(),
    name: z.string().trim().min(1, "Name is required").max(120),
    description: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .transform((v) => v || null),
    maxMarks: z.coerce.number().int("Whole number").min(1, "At least 1").max(100, "At most 100"),
    inputStyle: z.enum(["STARS", "SLIDER", "NUMBER"]),
    sortOrder: z.coerce.number().int().min(0).max(1000).default(0),
    isActive: z.boolean().default(true),
    sheetColumn: z
      .string()
      .trim()
      .max(200)
      .optional()
      .transform((v) => v || null),
  })
  .refine((c) => c.inputStyle !== "STARS" || c.maxMarks <= 10, {
    message: "Star ratings support at most 10 marks — use a slider or number for larger maximums",
    path: ["maxMarks"],
  });

export const domainSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(1, "Name is required").max(80),
  sortOrder: z.coerce.number().int().min(0).max(1000).default(0),
  isActive: z.boolean().default(true),
});

export const settingsSchema = z.object({
  allowResubmission: z.boolean(),
  tieBreakers: z
    .array(z.string())
    .max(10)
    .refine((ids) => ids.every(isTieBreakerId), "Unknown tie-breaker")
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate tie-breaker"),
});
