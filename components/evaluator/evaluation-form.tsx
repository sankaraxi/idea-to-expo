"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Check, CheckCircle2, CloudOff, Loader2, Lock, Pencil, Search, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { releaseMyEvaluation, saveDraft, submitEvaluation } from "@/lib/actions/evaluation";
import { chooseInitialDraft, draftKey, parseLocalDraft, pruneDraft, type DraftValues } from "@/lib/evaluations/draft";
import { cn } from "@/lib/utils";
import type { ClaimStatus, CriterionRow, DomainRow, EvaluationStatus, EventStatus } from "@/types/database";
import { CriterionInput } from "./criterion-input";

const AUTOSAVE_DELAY_MS = 1200;

type SaveState =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "local-only"; message: string };

interface Props {
  studentId: string;
  studentName: string;
  claimStatus: ClaimStatus;
  criteria: CriterionRow[];
  domains: DomainRow[];
  eventStatus: EventStatus;
  allowResubmission: boolean;
  remainingQuota: number;
  initial: (DraftValues & { status: EvaluationStatus; updatedAt: string }) | null;
}

function readLocal(key: string) {
  try {
    return parseLocalDraft(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}
function writeLocal(key: string, v: DraftValues) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ ...v, savedAt: Date.now() }));
  } catch {
    // storage full/blocked: the server autosave still protects the draft
  }
}
function clearLocal(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {}
}

export function EvaluationForm(props: Props) {
  const { studentId, studentName, criteria, domains, eventStatus, allowResubmission, initial } = props;
  const router = useRouter();
  const key = draftKey(studentId);
  const empty: DraftValues = { scores: {}, remarks: "", domainIds: [] };
  const [values, setValues] = useState<DraftValues>(initial ? pruneDraft(initial, criteria, domains.map((d) => d.id)) : empty);
  const [completed, setCompleted] = useState(initial?.status === "COMPLETED");
  const [claimed, setClaimed] = useState(props.claimStatus !== "AVAILABLE");
  const [editing, setEditing] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();
  const [releasing, startRelease] = useTransition();
  const timer = useRef<number | null>(null);
  const latest = useRef(values);
  const inflight = useRef(false);

  const total = criteria.reduce((sum, c) => sum + (values.scores[c.id] ?? 0), 0);
  const maxTotal = criteria.reduce((sum, c) => sum + c.max_marks, 0);
  const scoredAll = criteria.length > 0 && criteria.every((c) => values.scores[c.id] !== undefined);
  const quotaBlocked = !claimed && props.remainingQuota <= 0;

  const canDraft = (eventStatus === "LIVE" || eventStatus === "PAUSED") && !completed && !quotaBlocked;
  const canSubmit = eventStatus === "LIVE" && !quotaBlocked && (!completed || (allowResubmission && editing));
  const readOnly = (completed && !editing) || quotaBlocked || (!canDraft && !canSubmit);

  // Recover a newer local draft (refresh / crash / offline) once on mount.
  useEffect(() => {
    const chosen = chooseInitialDraft(initial ? { ...initial } : null, readLocal(key));
    if (chosen.source === "local") {
      const restored = pruneDraft(chosen, criteria, domains.map((d) => d.id));
      latest.current = restored;
      // Syncing from an external store (localStorage) after hydration is the intended use here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValues(restored);
      setSave({ kind: "dirty" });
      toast.info("Restored your unsaved draft for this student.");
    }
    if (initial?.status === "COMPLETED") clearLocal(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // flush and schedule reference each other; the ref breaks the cycle.
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const schedule = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flushRef.current(), AUTOSAVE_DELAY_MS);
  }, []);

  const flush = useCallback(async () => {
    if (!canDraft || inflight.current) return;
    inflight.current = true;
    const snapshot = latest.current;
    setSave({ kind: "saving" });
    const result = await saveDraft({ studentId, ...snapshot }).catch(() => null);
    inflight.current = false;
    if (result?.ok) {
      setClaimed(true);
      const changed = latest.current !== snapshot;
      setSave(changed ? { kind: "dirty" } : { kind: "saved", at: new Date() });
      if (changed) schedule();
    } else if (result && (result.code === "STUDENT_TAKEN" || result.code === "EVALUATOR_LIMIT_REACHED" || result.code === "ALREADY_SUBMITTED")) {
      setSave({ kind: "idle" });
      setError(result.message);
      router.refresh();
    } else {
      setSave({ kind: "local-only", message: result?.message ?? "Offline — saved on this device, will retry." });
    }
  }, [canDraft, studentId, schedule, router]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const update = useCallback(
    (patch: Partial<DraftValues>) => {
      if (readOnly) return;
      const next = { ...latest.current, ...patch };
      latest.current = next;
      setValues(next);
      setError(null);
      writeLocal(key, next);
      if (canDraft) {
        setSave({ kind: "dirty" });
        schedule();
      }
    },
    [readOnly, key, canDraft, schedule],
  );

  const setScore = (criterionId: string, score: number | undefined) => {
    const scores = { ...latest.current.scores };
    if (score === undefined) delete scores[criterionId];
    else scores[criterionId] = score;
    update({ scores });
  };

  const toggleDomain = (domainId: string, on: boolean) => {
    const set = new Set(latest.current.domainIds);
    if (on) set.add(domainId);
    else set.delete(domainId);
    update({ domainIds: [...set] });
  };

  // Retry failed autosaves periodically and when the connection returns.
  useEffect(() => {
    if (save.kind !== "local-only") return;
    const id = window.setInterval(() => void flushRef.current(), 10_000);
    const online = () => void flushRef.current();
    window.addEventListener("online", online);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("online", online);
    };
  }, [save.kind]);

  // Warn before leaving with changes that have not reached the server.
  useEffect(() => {
    if (save.kind !== "dirty" && save.kind !== "saving" && save.kind !== "local-only") return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [save.kind]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const submit = useCallback(() => {
    if (!canSubmit || submitting) return;
    if (!scoredAll) {
      setError("Score every criterion before submitting.");
      return;
    }
    if (timer.current) window.clearTimeout(timer.current);
    startSubmit(async () => {
      const result = await submitEvaluation({ studentId, ...latest.current }).catch(() => null);
      if (!result) {
        setError("Could not reach the server. Your draft is saved on this device — please try again.");
        return;
      }
      if (!result.ok) {
        setError(result.message);
        if (result.code === "ALREADY_SUBMITTED") setCompleted(true);
        return;
      }
      clearLocal(key);
      setCompleted(true);
      setClaimed(true);
      setEditing(false);
      setSave({ kind: "idle" });
      toast.success(`Evaluation submitted successfully — ${result.data.totalScore}/${result.data.maxTotal}.`);
      router.refresh();
    });
  }, [canSubmit, submitting, scoredAll, studentId, key, router]);

  const release = () => {
    if (!window.confirm(`Give ${studentName} back so another evaluator can take them? Your draft will be discarded.`)) return;
    startRelease(async () => {
      const result = await releaseMyEvaluation(studentId);
      if (!result.ok) return void toast.error(result.message);
      clearLocal(key);
      toast.success("Student released.");
      router.push("/evaluator");
    });
  };

  // Ctrl/⌘+Enter submits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submit]);

  if (criteria.length === 0) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          No evaluation criteria are set up yet. Please contact the event admin.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>Evaluation</span>
          <SaveIndicator state={save} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {quotaBlocked && (
          <Alert variant="destructive">
            <AlertDescription>You have reached your evaluation limit, so you cannot take another student.</AlertDescription>
          </Alert>
        )}
        {!claimed && !quotaBlocked && canDraft && (
          <Alert>
            <AlertDescription>Your first score reserves this student for you — no other evaluator can then take them.</AlertDescription>
          </Alert>
        )}
        {eventStatus !== "LIVE" && !completed && (
          <Alert>
            <AlertDescription>
              {eventStatus === "PAUSED"
                ? "Submissions are paused. Your draft keeps saving — submit once the event resumes."
                : eventStatus === "CLOSED"
                  ? "The event is closed. No new evaluations can be submitted."
                  : "Evaluation has not started yet. You can review the submission."}
            </AlertDescription>
          </Alert>
        )}
        {completed && !editing && (
          <div className="rounded-lg border border-success/30 bg-success/5 p-3 text-sm">
            <p className="flex items-center gap-2 font-medium text-success">
              <CheckCircle2 className="size-4" /> Evaluation submitted
            </p>
          </div>
        )}

        <div className="space-y-4">
          {criteria.map((c) => (
            <div key={c.id} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label id={`crit-${c.id}-label`} htmlFor={`crit-${c.id}`} className="font-medium">
                  {c.name}
                </Label>
                <span className="text-xs text-muted-foreground">max {c.max_marks}</span>
              </div>
              {c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}
              <CriterionInput
                id={`crit-${c.id}`}
                style={c.input_style}
                max={c.max_marks}
                value={values.scores[c.id]}
                disabled={readOnly}
                onChange={(v) => setScore(c.id, v)}
              />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2">
          <span className="text-sm font-medium">Total</span>
          <span className="text-lg font-semibold tabular-nums">
            {total}
            <span className="text-sm font-normal text-muted-foreground"> / {maxTotal}</span>
          </span>
        </div>

        {domains.length > 0 && (
          <fieldset className="space-y-2" disabled={readOnly}>
            <legend className="text-sm font-medium">Related domains</legend>
            <div className="grid grid-cols-2 gap-2">
              {domains.map((d) => (
                <label key={d.id} className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    checked={values.domainIds.includes(d.id)}
                    onCheckedChange={(on) => toggleDomain(d.id, on === true)}
                    disabled={readOnly}
                  />
                  {d.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="space-y-2">
          <Label htmlFor="remarks">Remarks</Label>
          <Textarea
            id="remarks"
            value={values.remarks}
            onChange={(e) => update({ remarks: e.target.value })}
            placeholder="Optional remarks…"
            rows={4}
            maxLength={5000}
            readOnly={readOnly}
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!readOnly && (
          <Button className="h-11 w-full text-base" onClick={submit} disabled={!canSubmit || submitting}>
            {submitting ? <Loader2 className="animate-spin" /> : <Check />}
            {editing ? "Update evaluation" : "Submit Evaluation"}
            <span className="opacity-80">· {total}/{maxTotal}</span>
          </Button>
        )}

        {claimed && !completed && canDraft && (
          <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={release} disabled={releasing}>
            <Undo2 /> Release this student
          </Button>
        )}

        {completed && !editing && allowResubmission && eventStatus === "LIVE" && (
          <Button variant="outline" className="w-full" onClick={() => setEditing(true)}>
            <Pencil /> Revise this evaluation
          </Button>
        )}
        {completed && !editing && !allowResubmission && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3" /> Submitted evaluations are locked.
          </p>
        )}
        {completed && !editing && (
          <Link href="/evaluator/search" className={cn(buttonVariants(), "h-11 w-full text-base")}>
            <Search /> Find next student
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const base = "inline-flex items-center gap-1 text-xs font-normal";
  switch (state.kind) {
    case "saving":
      return (
        <span className={cn(base, "text-muted-foreground")}>
          <Loader2 className="size-3 animate-spin" /> Saving…
        </span>
      );
    case "saved":
      return (
        <span className={cn(base, "text-success")}>
          <Check className="size-3" /> Saved ✓ {state.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      );
    case "dirty":
      return <span className={cn(base, "text-muted-foreground")}>Unsaved changes</span>;
    case "local-only":
      return (
        <span className={cn(base, "text-[oklch(0.55_0.13_70)]")} title={state.message}>
          <CloudOff className="size-3" /> Saved on this device
        </span>
      );
    default:
      return null;
  }
}
