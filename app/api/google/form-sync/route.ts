import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { verifySignedRequest } from "@/lib/auth/signature";
import { secret } from "@/lib/env";
import { ingestFormRows } from "@/lib/forms/service";
import { scheduleSheetSync } from "@/lib/sheets/trigger";

export const maxDuration = 60;

const payloadSchema = z.object({
  headers: z.array(z.string()).min(1).max(200),
  rows: z.array(z.array(z.unknown()).max(200)).max(5000),
  firstRow: z.number().int().min(2).default(2),
});

/**
 * Webhook for the Google Apps Script (scripts/google-apps-script/FormSync.gs).
 * Called on every form submit and by a periodic full replay; ingestion is an
 * idempotent register-number upsert, so duplicates/replays are harmless.
 */
export async function POST(request: NextRequest) {
  const key = secret("FORM_SYNC_SECRET");
  if (!key) return NextResponse.json({ error: "Form sync is not configured" }, { status: 503 });

  const body = await request.text();
  if (body.length > 10 * 1024 * 1024) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  if (!verifySignedRequest(key, body, request.headers.get("x-timestamp"), request.headers.get("x-signature"))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  try {
    const result = await ingestFormRows(parsed.data.headers, parsed.data.rows, "APPS_SCRIPT", null, parsed.data.firstRow);
    scheduleSheetSync();
    return NextResponse.json(result, { status: result.status === "FAILED" ? 422 : 200 });
  } catch (error) {
    console.error("[form-sync]", error);
    return NextResponse.json({ error: "Ingestion failed" }, { status: 500 });
  }
}
