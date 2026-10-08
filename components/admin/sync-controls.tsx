"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { DatabaseBackup, Loader2, Play, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { fullResync, retryFailedSync, runSheetSyncNow } from "@/lib/actions/admin";

export function SyncControls({ configured, pending }: { configured: boolean; pending: number }) {
  const [busy, start] = useTransition();
  const [auto, setAuto] = useState(false);

  const run = (quiet = false) =>
    start(async () => {
      const res = await runSheetSyncNow();
      if (!res.ok) {
        toast.error(res.message);
        return;
      }
      const r = res.data;
      if (quiet) return;
      if (r.status === "disabled") toast.error("Google Sheets is not configured.");
      else if (r.status === "locked") toast.info("Another sync is already running.");
      else if (r.failed > 0) toast.error(`${r.processed} synced, ${r.failed} failed: ${r.errors[0] ?? ""}`);
      else toast.success(r.processed ? `${r.processed} changes synced to Google Sheets.` : "Already up to date.");
    });

  // While this page is open, keep draining the queue every 15 s (safety net if cron is not set up).
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    if (!auto) return;
    const id = window.setInterval(() => runRef.current(true), 15_000);
    return () => window.clearInterval(id);
  }, [auto]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={() => run()} disabled={busy || !configured}>
        {busy ? <Loader2 className="animate-spin" /> : <Play />} Sync now {pending > 0 && `(${pending})`}
      </Button>
      <Button
        variant="outline"
        disabled={busy || !configured}
        onClick={() =>
          start(async () => {
            const res = await retryFailedSync();
            if (res.ok) toast.success(`${res.data.count} failed job(s) re-queued.`);
            else toast.error(res.message);
          })
        }
      >
        <RotateCcw /> Retry failed
      </Button>
      <Button
        variant="outline"
        disabled={busy || !configured}
        onClick={() => {
          if (!window.confirm("Re-send every student, evaluator, assignment and evaluation to the sheet?")) return;
          start(async () => {
            const res = await fullResync();
            if (res.ok) toast.success(`${res.data.count} jobs queued for full resync.`);
            else toast.error(res.message);
          });
        }}
      >
        <DatabaseBackup /> Full resync
      </Button>
      <label className="ml-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Switch checked={auto} onCheckedChange={setAuto} disabled={!configured} /> Auto-sync while open
      </label>
    </div>
  );
}
