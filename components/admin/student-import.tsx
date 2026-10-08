"use client";

import { useRef, useState, useTransition } from "react";
import { FileUp, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { importStudentsCsv, syncGoogleForm } from "@/lib/actions/admin";
import type { IngestResult } from "@/lib/forms/service";

function summary(r: IngestResult) {
  return `${r.received} rows · ${r.inserted} new · ${r.updated} updated · ${r.unchanged} unchanged · ${r.skipped} skipped`;
}

export function StudentImportControls() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<IngestResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const report = (r: IngestResult) => {
    setResult(r);
    if (r.status === "SUCCESS") toast.success(summary(r));
    else if (r.status === "PARTIAL") toast.warning(summary(r));
    else toast.error(r.errors[0]?.error ?? "Import failed");
  };

  const pull = () =>
    start(async () => {
      const res = await syncGoogleForm();
      if (res.ok) report(res.data);
      else toast.error(res.message);
    });

  const upload = (file: File) =>
    start(async () => {
      const form = new FormData();
      form.set("file", file);
      const res = await importStudentsCsv(form);
      if (res.ok) report(res.data);
      else toast.error(res.message);
      if (fileRef.current) fileRef.current.value = "";
    });

  return (
    <>
      <Button variant="outline" onClick={pull} disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync Google Form
      </Button>
      <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={pending}>
        <FileUp /> Import CSV
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
      />

      <Dialog open={!!result && result.errors.length > 0} onOpenChange={(o) => !o && setResult(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import finished with issues</DialogTitle>
            <DialogDescription>{result && summary(result)}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-72 space-y-1 overflow-y-auto text-sm">
            {result?.errors.map((e, i) => (
              <li key={i} className="rounded bg-muted px-2 py-1">
                {e.row ? `Row ${e.row}` : ""} {e.register_number ? `(${e.register_number})` : ""}: {e.error}
              </li>
            ))}
          </ul>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </>
  );
}
