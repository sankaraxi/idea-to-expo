"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Shuffle, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { selectClass } from "@/components/shared/ui-bits";
import { confirmAllocation, previewAllocation } from "@/lib/actions/admin";
import type { AllocationFailure, AllocationType } from "@/lib/allocation/plan";
import type { AllocationPreview } from "@/lib/allocation/service";

const TYPE_LABELS: Record<AllocationType, string> = {
  INITIAL: "Initial allocation",
  INCREMENTAL: "Allocate unassigned students (keep existing)",
  FULL_REALLOCATION: "Full reallocation (redraw all untouched assignments)",
};

function failureText(f: AllocationFailure) {
  const s = f.summary;
  switch (f.code) {
    case "INSUFFICIENT_CAPACITY":
      return {
        title: "Insufficient evaluator capacity.",
        lines: [
          `Students: ${s.studentsNeedingAllocation}${s.evaluatorsPerStudent > 1 ? ` (× ${s.evaluatorsPerStudent} = ${s.assignmentsRequired} assignments)` : ""}`,
          `Available Capacity: ${s.availableCapacity}`,
          `Additional Capacity Required: ${f.additionalCapacityRequired}`,
        ],
      };
    case "NOTHING_TO_ALLOCATE":
      return { title: "Nothing to allocate.", lines: ["Every active student already has the required number of evaluators."] };
    case "NO_EVALUATORS":
      return { title: "No active evaluators.", lines: ["Add or enable evaluators first."] };
    case "NOT_ENOUGH_EVALUATORS":
      return { title: "Not enough evaluators.", lines: [`${s.evaluatorsPerStudent} evaluators per student requires at least that many active evaluators (have ${s.activeEvaluators}).`] };
    case "UNSATISFIABLE":
      return { title: "Could not find a valid distribution.", lines: ["Per-evaluator caps or existing assignments prevent a complete allocation. Raise caps and retry."] };
  }
}

export function AllocationPanel({
  activeStudents,
  evaluatorCaps,
  liveAssignments,
  defaults,
}: {
  activeStudents: number;
  evaluatorCaps: number[];
  liveAssignments: number;
  defaults: { maxPerEvaluator: number; evaluatorsPerStudent: number };
}) {
  const [maxPerEvaluator, setMax] = useState(defaults.maxPerEvaluator);
  const [perStudent, setPerStudent] = useState(defaults.evaluatorsPerStudent);
  const [type, setType] = useState<AllocationType>(liveAssignments === 0 ? "INITIAL" : "INCREMENTAL");
  const [preview, setPreview] = useState<AllocationPreview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, start] = useTransition();

  const capacity = useMemo(
    () => evaluatorCaps.reduce((sum, cap) => sum + Math.min(cap, maxPerEvaluator || 0), 0),
    [evaluatorCaps, maxPerEvaluator],
  );
  const required = activeStudents * perStudent;
  const possible = type !== "INITIAL" || (capacity >= required && evaluatorCaps.length >= perStudent);

  const config = { type, maxPerEvaluator, evaluatorsPerStudent: perStudent };

  const generate = () =>
    start(async () => {
      const res = await previewAllocation(config);
      if (res.ok) setPreview(res.data);
      else toast.error(res.message);
    });

  const confirm = () =>
    start(async () => {
      if (!preview?.ok) return;
      const res = await confirmAllocation({ ...preview.config, seed: preview.seed, fingerprint: preview.fingerprint });
      setConfirmOpen(false);
      if (res.ok) {
        toast.success(`Allocation confirmed: ${res.data.assignmentCount} assignments created.`);
        setPreview(null);
      } else {
        toast.error(res.message);
        if (res.code === "STALE_PREVIEW") setPreview(null);
      }
    });

  const failure = preview && !preview.ok ? failureText(preview.failure) : null;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>The preview is computed server-side and nothing is saved until you confirm.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="max">Maximum students per evaluator</Label>
              <Input id="max" type="number" min={1} max={1000} value={maxPerEvaluator} onChange={(e) => { setMax(Number(e.target.value)); setPreview(null); }} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="per">Evaluators per student</Label>
              <select id="per" className={`${selectClass} h-8 w-full`} value={perStudent} onChange={(e) => { setPerStudent(Number(e.target.value)); setPreview(null); }}>
                {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="type">Mode</Label>
              <select id="type" className={`${selectClass} h-8 w-full`} value={type} onChange={(e) => { setType(e.target.value as AllocationType); setPreview(null); }}>
                {(liveAssignments === 0 ? (["INITIAL"] as const) : (["INCREMENTAL", "FULL_REALLOCATION"] as const)).map((t) => (
                  <option key={t} value={t}>{TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-3 rounded-lg bg-muted/60 p-4 text-sm sm:grid-cols-4">
            <div><p className="text-muted-foreground">Students</p><p className="text-lg font-semibold tabular-nums">{activeStudents}</p></div>
            <div><p className="text-muted-foreground">Evaluators</p><p className="text-lg font-semibold tabular-nums">{evaluatorCaps.length}</p></div>
            <div><p className="text-muted-foreground">Capacity</p><p className="text-lg font-semibold tabular-nums">{capacity}</p></div>
            <div>
              <p className="text-muted-foreground">Status</p>
              {type === "INITIAL" ? (
                possible ? (
                  <p className="flex items-center gap-1 font-medium text-success"><CheckCircle2 className="size-4" /> Allocation possible</p>
                ) : (
                  <p className="flex items-center gap-1 font-medium text-destructive"><AlertTriangle className="size-4" /> Needs {Math.max(0, required - capacity)} more capacity</p>
                )
              ) : (
                <p className="text-muted-foreground">Checked on generate ({liveAssignments} live assignments)</p>
              )}
            </div>
          </div>

          {type === "FULL_REALLOCATION" && (
            <Alert>
              <AlertTriangle className="size-4" />
              <AlertDescription>
                Pending assignments with no evaluation activity are replaced (kept in history). In-progress and completed evaluations are never touched.
              </AlertDescription>
            </Alert>
          )}

          <Button size="lg" onClick={generate} disabled={pending || !possible || maxPerEvaluator < 1}>
            {pending && !preview ? <Loader2 className="animate-spin" /> : <Shuffle />} Generate Random Allocation
          </Button>
        </CardContent>
      </Card>

      {failure && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>
            {failure.lines.map((l) => <p key={l}>{l}</p>)}
            <p className="mt-1">No students were allocated.</p>
          </AlertDescription>
        </Alert>
      )}

      {preview?.ok && (
        <Card className="ring-2 ring-primary/30">
          <CardHeader>
            <CardTitle>Allocation Preview</CardTitle>
            <CardDescription>
              {TYPE_LABELS[preview.config.type]} · Total students: {preview.summary.studentsNeedingAllocation} · Evaluators: {preview.summary.activeEvaluators} · Maximum per evaluator: {preview.config.maxPerEvaluator}
              {preview.config.evaluatorsPerStudent > 1 && ` · ${preview.config.evaluatorsPerStudent} evaluators per student`}
              {preview.replaceable > 0 && ` · replaces ${preview.replaceable} untouched assignments`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-h-[420px] overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Evaluator</TableHead>
                    <TableHead className="text-right">Existing</TableHead>
                    <TableHead className="text-right">New</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Cap</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.evaluators.map((e) => (
                    <TableRow key={e.evaluatorId}>
                      <TableCell className="font-medium">{e.name}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{e.existing}</TableCell>
                      <TableCell className="text-right tabular-nums">→ {e.added}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{e.total}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{e.capacity}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-sm text-muted-foreground">{preview.assignmentCount} assignments will be created.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={generate} disabled={pending}>
                <RefreshCw /> Regenerate
              </Button>
              <Button variant="ghost" onClick={() => setPreview(null)} disabled={pending}>
                <X /> Cancel
              </Button>
              <Button onClick={() => setConfirmOpen(true)} disabled={pending} className="ml-auto">
                <CheckCircle2 /> Confirm Allocation
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm allocation?</AlertDialogTitle>
            <AlertDialogDescription>
              {preview?.ok && `${preview.assignmentCount} assignments will be created and evaluators will see their students immediately.`} This is recorded as a new allocation batch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <Button onClick={confirm} disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Confirm
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
