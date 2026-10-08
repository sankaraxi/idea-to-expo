"use client";

import { useState, useTransition } from "react";
import { RotateCcw, UserX } from "lucide-react";
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
import { releaseEvaluation, reopenEvaluation } from "@/lib/actions/admin";

/**
 * Admins never edit scores. They either reopen a submission (same evaluator
 * revises it) or release the student (evaluation removed, any evaluator can
 * take them). Both require a reason and are audited.
 */
function ReasonDialog({
  title,
  description,
  confirmLabel,
  icon,
  run,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  icon: React.ReactNode;
  run: (reason: string) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        {icon} {confirmLabel}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="admin-reason">Reason</Label>
          <Textarea id="admin-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={pending || reason.trim().length < 3}
            onClick={() =>
              start(async () => {
                const res = await run(reason);
                if (!res.ok) return void toast.error(res.message ?? "Failed");
                toast.success("Done.");
                setOpen(false);
                setReason("");
              })
            }
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EvaluationAdminActions({
  evaluationId,
  status,
  label,
}: {
  evaluationId: string;
  status: "IN_PROGRESS" | "COMPLETED";
  label: string;
}) {
  return (
    <div className="flex justify-end">
      {status === "COMPLETED" && (
        <ReasonDialog
          title="Reopen evaluation?"
          description={`${label}. The same evaluator can revise and re-submit; it leaves the results until then.`}
          confirmLabel="Reopen"
          icon={<RotateCcw />}
          run={(reason) => reopenEvaluation(evaluationId, reason)}
        />
      )}
      <ReasonDialog
        title="Release student?"
        description={`${label}. The evaluation is removed (scores are kept in the audit log) and any evaluator can then take this student.`}
        confirmLabel="Release"
        icon={<UserX />}
        run={(reason) => releaseEvaluation(evaluationId, reason)}
      />
    </div>
  );
}
