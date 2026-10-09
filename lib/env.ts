import { z } from "zod";

/**
 * Environment access. Values are validated lazily so a missing optional
 * integration (Google) never breaks unrelated pages.
 */

const databaseSchema = z
  .string()
  .min(1, "DATABASE_URL is not set")
  .refine((v) => /^mysql:\/\//i.test(v), "DATABASE_URL must start with mysql://");

/** mysql://user:password@host:3306/idea_to_expo  (URL-encode special characters in the password). */
export function databaseUrl(): string {
  const parsed = databaseSchema.safeParse(process.env.DATABASE_URL ?? "");
  if (!parsed.success) {
    throw new Error(
      `${parsed.error.issues[0]?.message}. Example: DATABASE_URL=mysql://root:password@127.0.0.1:3306/idea_to_expo`,
    );
  }
  return parsed.data;
}

const googleSchema = z.object({
  GOOGLE_CLIENT_EMAIL: z.email(),
  GOOGLE_PRIVATE_KEY: z.string().min(100),
});

export interface GoogleConfig {
  clientEmail: string;
  privateKey: string;
  /** Optional reporting spreadsheet (Students / Evaluators / Evaluations / Results / Dashboard tabs). */
  sheetId: string | null;
  /** Problem statement (form response) spreadsheet: ingested, and scores are written back into it. */
  formResponseSheetId: string | null;
  formResponseRange: string;
}

/** Returns null when Google credentials are not configured (sync is then reported as disabled). */
export function googleConfig(): GoogleConfig | null {
  const parsed = googleSchema.safeParse(process.env);
  if (!parsed.success) return null;
  return {
    clientEmail: parsed.data.GOOGLE_CLIENT_EMAIL,
    // Vercel/.env store the PEM with literal "\n".
    privateKey: parsed.data.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    sheetId: process.env.GOOGLE_SHEET_ID || null,
    formResponseSheetId: process.env.GOOGLE_FORM_RESPONSE_SHEET_ID || null,
    formResponseRange: process.env.GOOGLE_FORM_RESPONSE_RANGE || "Form Responses 1",
  };
}

export function secret(name: "CRON_SECRET" | "FORM_SYNC_SECRET"): string | null {
  const value = process.env[name];
  return value && value.length >= 16 ? value : null;
}
