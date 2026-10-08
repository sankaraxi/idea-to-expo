"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ArrowRight, Check, CheckCircle2, CloudOff, Loader2, Lock, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveDraft, submitEvaluation } from "@/lib/actions/evaluation";
import { chooseInitialDraft, draftKey, parseLocalDraft } from "@/lib/evaluations/draft";
import { cn } from "@/lib/utils";
import type { EvaluationStatus, EventStatus } from "@/types/database";

const SCORES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const AUTOSAVE_DELAY_MS = 1200;

type SaveState =
  | { kind: "idle" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "local-only"; message: string };

interface Props {
  assignmentId: string;
  studentName: string;
  eventStatus: EventStatus;
  allowResubmission: boolean;
  initial: {
    score: number | null;
    remarks: string;
    status: EvaluationStatus;
    updatedAt: string;
    submittedAt: string | null;
  } | null;
  nextHref: string | null;
  nextLabel: string | null;
}

function readLocal(key: string) {
  try {
    return parseLocalDraft(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}
function writeLocal(key: string, score: number | null, remarks: string) {
  try {
    window.localStorage.setItem(key, JSON.stringify({ score, remarks, savedAt: Date.now() }));
  } catch {
    // storage full/blocked: the server autosave still protects the draft
  }
}
function clearLocal(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {}
}

export function EvaluationForm({ assignmentId, studentName, eventStatus, allowResubmission, initial, nextHref, nextLabel }: Props) {
  const router = useRouter();
  const key = draftKey(assignmentId);
  const [score, setScore] = useState<number | null>(initial?.score ?? null);
  const [remarks, setRemarks] = useState(initial?.remarks ?? "");
  const [completed, setCompleted] = useState(initial?.status === "COMPLETED");
  const [editing, setEditing] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();
  const timer = useRef<number | null>(null);
  const latest = useRef({ score, remarks });
  const inflight = useRef(false);

  const canDraft = (eventStatus === "LIVE" || eventStatus === "PAUSED") && !completed;
  const canSubmit = eventStatus === "LIVE" && (!completed || (allowResubmission && editing));
  const readOnly = completed && !editing;

  // Recover a newer local draft (refresh / crash / offline) once on mount.
  useEffect(() => {
    const chosen = chooseInitialDraft(
      initial ? { score: initial.score, remarks: initial.remarks, status: initial.status, updatedAt: initial.updatedAt } : null,
      readLocal(key),
    );
    if (chosen.source === "local") {
      // Syncing from an external store (localStorage) after hydration is the intended use here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setScore(chosen.score);
      setRemarks(chosen.remarks);
      latest.current = { score: chosen.score, remarks: chosen.remarks };
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
    const result = await saveDraft({ assignmentId, score: snapshot.score, remarks: snapshot.remarks }).catch(() => null);
    inflight.current = false;
    if (result?.ok) {
      const changedSince = latest.current.score !== snapshot.score || latest.current.remarks !== snapshot.remarks;
      setSave(changedSince ? { kind: "dirty" } : { kind: "saved", at: new Date() });
      if (changedSince) schedule();
    } else if (result && result.code === "ALREADY_SUBMITTED") {
      setCompleted(true);
      setSave({ kind: "idle" });
    } else {
      setSave({ kind: "local-only", message: result?.message ?? "Offline — saved on this device, will retry." });
    }
  }, [assignmentId, canDraft, schedule]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const update = useCallback(
    (next: { score?: number | null; remarks?: string }) => {
      if (readOnly) return;
      const value = { ...latest.current, ...next };
      latest.current = value;
      if (next.score !== undefined) setScore(next.score);
      if (next.remarks !== undefined) setRemarks(next.remarks);
      setError(null);
      writeLocal(key, value.score, value.remarks);
      if (canDraft) {
        setSave({ kind: "dirty" });
        schedule();
      }
    },
    [readOnly, key, canDraft, schedule],
  );

  // Retry failed autosaves periodically and when the connection returns.
  useEffect(() => {
    if (save.kind !== "local-only") return;
    const id = window.setInterval(() => void flush(), 10_000);
    const online = () => void flush();
    window.addEventListener("online", online);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("online", online);
    };
  }, [save.kind, flush]);

  // Warn before leaving with changes that have not reached the server.
  useEffect(() => {
    const unsynced = save.kind === "dirty" || save.kind === "saving" || save.kind === "local-only";
    if (!unsynced) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [save.kind]);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const submit = useCallback(() => {
    if (!canSubmit || submitting) return;
    if (score === null) {
      setError("Select a score from 1 to 10 before submitting.");
      return;
    }
    if (timer.current) window.clearTimeout(timer.current);
    startSubmit(async () => {
      const result = await submitEvaluation({ assignmentId, score, remarks }).catch(() => null);
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
      setEditing(false);
      setSave({ kind: "idle" });
      toast.success("Evaluation submitted successfully.");
      router.refresh();
    });
  }, [canSubmit, submitting, score, remarks, assignmentId, key, router]);

  // Keyboard: 1–9, 0 = 10, Ctrl/⌘+Enter submit, "n" next student after submitting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).tagName === "TEXTAREA" || (e.target as HTMLElement).tagName === "INPUT";
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submit();
        return;
      }
      if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
      if (/^[0-9]$/.test(e.key) && !readOnly) {
        update({ score: e.key === "0" ? 10 : Number(e.key) });
      } else if (e.key === "n" && completed && !editing && nextHref) {
        router.push(nextHref);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [submit, update, readOnly, completed, editing, nextHref, router]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>Evaluation</span>
          <SaveIndicator state={save} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
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
            <p className="mt-1 text-muted-foreground">Submitted score for {studentName}: <span className="font-semibold text-foreground">{score}</span></p>
          </div>
        )}

        <fieldset disabled={readOnly || (!canDraft && !canSubmit)} className="space-y-2">
          <Label id="score-label">Score</Label>
          <div role="radiogroup" aria-labelledby="score-label" className="grid grid-cols-5 gap-2">
            {SCORES.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={score === n}
                onClick={() => update({ score: n })}
                className={cn(
                  "h-11 rounded-lg border text-base font-semibold tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  score === n
                    ? "border-primary bg-primary text-primary-foreground shadow-sm"
                    : "bg-background hover:border-primary/50 hover:bg-accent",
                )}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Keys 1–9, 0 for 10.</p>
        </fieldset>

        <div className="space-y-2">
          <Label htmlFor="remarks">Remarks</Label>
          <Textarea
            id="remarks"
            value={remarks}
            onChange={(e) => update({ remarks: e.target.value })}
            placeholder="Optional remarks…"
            rows={6}
            maxLength={5000}
            readOnly={readOnly}
            disabled={!readOnly && !canDraft && !canSubmit}
          />
          <p className="text-right text-xs text-muted-foreground">{remarks.length}/5000</p>
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
            {score !== null && <span className="opacity-80">· {score}/10</span>}
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
          nextHref ? (
            <Link href={nextHref} className={cn(buttonVariants(), "h-11 w-full text-base")}>
              Next Student <ArrowRight />
            </Link>
          ) : (
            <Link href="/evaluator" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
              All done — back to dashboard
            </Link>
          )
        )}
        {completed && !editing && nextLabel && (
          <p className="text-center text-xs text-muted-foreground">
            Next: {nextLabel} · press <kbd>n</kbd>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const base = "inline-flex items-center gap-1 text-xs font-normal";
  switch (state.kind) {
    case "saving":
      return <span className={cn(base, "text-muted-foreground")}><Loader2 className="size-3 animate-spin" /> Saving…</span>;
    case "saved":
      return <span className={cn(base, "text-success")}><Check className="size-3" /> Saved ✓ {state.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>;
    case "dirty":
      return <span className={cn(base, "text-muted-foreground")}>Unsaved changes</span>;
    case "local-only":
      return <span className={cn(base, "text-[oklch(0.55_0.13_70)]")} title={state.message}><CloudOff className="size-3" /> Saved on this device</span>;
    default:
      return null;
  }
}
