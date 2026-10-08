import { NextResponse, type NextRequest } from "next/server";
import { safeEqual } from "@/lib/auth/signature";
import { secret } from "@/lib/env";
import { processSyncQueue } from "@/lib/sheets/worker";

export const maxDuration = 60;

/**
 * Sheet sync worker endpoint for schedulers (Vercel Cron, Supabase pg_cron +
 * pg_net, or any uptime pinger). Requires `Authorization: Bearer $CRON_SECRET`.
 */
async function handle(request: NextRequest) {
  const expected = secret("CRON_SECRET");
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!expected || !safeEqual(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const report = await processSyncQueue({ timeBudgetMs: 50_000 });
  return NextResponse.json(report, { status: report.status === "error" ? 500 : 200 });
}

export const GET = handle;
export const POST = handle;
