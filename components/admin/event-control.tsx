"use client";

import { useState, useTransition } from "react";
import { Pause, Play, Square, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { EVENT_STATUS_HELP, EventStatusBadge } from "@/components/shared/event-status-badge";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { setEventStatus } from "@/lib/actions/admin";
import type { EventStatus } from "@/types/database";

const ACTIONS: { to: EventStatus; label: string; icon: typeof Play; from: EventStatus[]; variant?: "destructive" | "outline" }[] = [
  { to: "LIVE", label: "Go live", icon: Play, from: ["NOT_STARTED", "PAUSED", "CLOSED"] },
  { to: "PAUSED", label: "Pause", icon: Pause, from: ["LIVE"], variant: "outline" },
  { to: "CLOSED", label: "Close event", icon: Square, from: ["LIVE", "PAUSED"], variant: "destructive" },
  { to: "NOT_STARTED", label: "Reset to not started", icon: RotateCcw, from: ["PAUSED", "CLOSED"], variant: "outline" },
];

export function EventControl({ status }: { status: EventStatus }) {
  const [target, setTarget] = useState<EventStatus | null>(null);
  const [pending, start] = useTransition();

  const confirm = () =>
    start(async () => {
      if (!target) return;
      const result = await setEventStatus(target);
      if (result.ok) toast.success(`Event is now ${target.replace("_", " ").toLowerCase()}.`);
      else toast.error(result.message);
      setTarget(null);
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <EventStatusBadge status={status} className="text-sm" />
        <span className="text-sm text-muted-foreground">{EVENT_STATUS_HELP[status]}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {ACTIONS.filter((a) => a.from.includes(status)).map((a) => (
          <Button key={a.to} variant={a.variant ?? "default"} onClick={() => setTarget(a.to)}>
            <a.icon /> {a.label}
          </Button>
        ))}
      </div>

      <AlertDialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change event status to {target?.replace("_", " ")}?</AlertDialogTitle>
            <AlertDialogDescription>{target ? EVENT_STATUS_HELP[target] : ""} This affects every evaluator immediately.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button onClick={confirm} disabled={pending} variant={target === "CLOSED" ? "destructive" : "default"}>
              Confirm
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
