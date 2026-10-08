import { z } from "zod";

/**
 * Environment access. Public values are inlined by Next.js at build time and
 * must be referenced literally; server values are validated lazily so a
 * missing optional integration (Google) never breaks unrelated pages.
 */

export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
};

export function assertPublicEnv() {
  if (!publicEnv.supabaseUrl || !publicEnv.supabaseAnonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set");
  }
  return publicEnv;
}

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, "SUPABASE_SERVICE_ROLE_KEY is required"),
});

const googleSchema = z.object({
  GOOGLE_CLIENT_EMAIL: z.email(),
  GOOGLE_PRIVATE_KEY: z.string().min(100),
});

export function serverEnv() {
  return serverSchema.parse(process.env);
}

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
