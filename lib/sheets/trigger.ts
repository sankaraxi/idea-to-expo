import "server-only";
import { after } from "next/server";
import { processSyncQueue } from "./worker";

/**
 * Kicks the sheet worker after the response has been sent. The user never
 * waits on (or sees failures from) Google; failed jobs stay queued and are
 * retried by the next trigger / cron run.
 */
export function scheduleSheetSync() {
  after(async () => {
    try {
      const report = await processSyncQueue({ timeBudgetMs: 20_000 });
      if (report.status === "error") console.error("[sheets] background sync error", report.errors);
    } catch (error) {
      console.error("[sheets] background sync crashed", error);
    }
  });
}
