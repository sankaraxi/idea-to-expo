"use client";

import { useState, useTransition } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { reopenEvaluation } from "@/lib/actions/admin";

/** Admins never edit scores directly; they reopen with a reason (audited) and the evaluator re-submits. */
export function ReopenEvaluationButton({ evaluationId, label }: { evaluationId: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      const result = await reopenEvaluation(evaluationId, reason);
      if (result.ok) {
        toast.success("Evaluation reopened for the evaluator.");
        setOpen(false);
        setReason("");
      } else toast.error(result.message);
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        <RotateCcw /> Reopen
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reopen evaluation?</DialogTitle>
          <DialogDescription>
            {label}. The score is removed from results until the evaluator submits again. This action is audited.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`reason-${evaluationId}`}>Reason</Label>
          <Textarea id={`reason-${evaluationId}`} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </div>
        <DialogFooter>
          <Button variant="destructive" onClick={submit} disabled={pending || reason.trim().length < 3}>
            Reopen evaluation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
