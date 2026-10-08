"use client";

import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, Loader2, Save, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import { selectClass } from "@/components/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { saveFormMapping, saveSettings, saveSheetWriteback } from "@/lib/actions/admin";
import { FORM_FIELDS, FORM_FIELD_LABELS, normalizeHeader, type FormFieldMapping } from "@/lib/forms/mapping";

export function EvaluationSettingsForm({
  allowResubmission,
  maxEvaluations,
  tieBreakers,
  options,
}: {
  allowResubmission: boolean;
  maxEvaluations: number;
  tieBreakers: string[];
  options: { id: string; label: string }[];
}) {
  const [allow, setAllow] = useState(allowResubmission);
  const [max, setMax] = useState(String(maxEvaluations));
  const [rules, setRules] = useState(tieBreakers.filter((t) => options.some((o) => o.id === t)));
  const [pending, start] = useTransition();
  const available = options.filter((o) => !rules.includes(o.id));
  const label = (id: string) => options.find((o) => o.id === id)?.label ?? id;

  const move = (i: number, d: -1 | 1) =>
    setRules((r) => {
      const next = [...r];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return next;
    });

  const save = () =>
    start(async () => {
      const res = await saveSettings({ allowResubmission: allow, maxEvaluationsPerEvaluator: Number(max), tieBreakers: rules });
      if (res.ok) toast.success("Settings saved.");
      else toast.error(res.message);
    });

  return (
    <div className="space-y-6">
      <div className="max-w-xs space-y-1.5">
        <Label htmlFor="max-evals">Maximum students per evaluator</Label>
        <Input id="max-evals" type="number" min={1} max={1000} value={max} onChange={(e) => setMax(e.target.value)} />
        <p className="text-xs text-muted-foreground">Includes drafts. Individual evaluators can have a lower limit.</p>
      </div>

      <label className="flex items-start gap-3">
        <Switch checked={allow} onCheckedChange={setAllow} className="mt-0.5" />
        <span>
          <span className="block text-sm font-medium">Allow evaluators to revise submitted evaluations</span>
          <span className="block text-sm text-muted-foreground">
            While the event is LIVE. When off, a submitted evaluation is final unless an admin reopens it.
          </span>
        </span>
      </label>

      <div className="space-y-2">
        <Label>Tie-break rules (after total score, in order)</Label>
        <ol className="space-y-1.5">
          {rules.map((id, i) => (
            <li key={id} className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm">
              <span className="w-5 text-muted-foreground">{i + 1}.</span>
              <span className="flex-1">{label(id)}</span>
              <Button variant="ghost" size="icon-xs" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                <ArrowUp />
              </Button>
              <Button variant="ghost" size="icon-xs" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                <ArrowDown />
              </Button>
              <Button variant="ghost" size="icon-xs" onClick={() => setRules((r) => r.filter((x) => x !== id))} aria-label="Remove">
                <X />
              </Button>
            </li>
          ))}
          {rules.length === 0 && <li className="text-sm text-muted-foreground">No tie-breakers: equal totals share a rank.</li>}
        </ol>
        {available.length > 0 && (
          <select
            className={selectClass}
            value=""
            onChange={(e) => e.target.value && setRules((r) => [...r, e.target.value])}
            aria-label="Add tie-break rule"
          >
            <option value="">+ Add rule…</option>
            {available.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </div>

      <Button onClick={save} disabled={pending}>
        {pending && <Loader2 className="animate-spin" />} Save settings
      </Button>
    </div>
  );
}

export function FormMappingForm({ mapping }: { mapping: FormFieldMapping }) {
  const [fields, setFields] = useState<Record<string, string>>(
    Object.fromEntries(FORM_FIELDS.map((f) => [f, (mapping.fields[f] ?? []).join(", ")])),
  );
  const [ignore, setIgnore] = useState(mapping.ignore.join(", "));
  const [pending, start] = useTransition();
  const split = (v: string) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const save = () =>
    start(async () => {
      const res = await saveFormMapping({
        fields: Object.fromEntries(FORM_FIELDS.map((f) => [f, split(fields[f] ?? "")]).filter(([, v]) => v.length)),
        ignore: split(ignore),
      });
      if (res.ok) toast.success("Form mapping saved. It applies to the next sync.");
      else toast.error(res.message);
    });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Comma-separated question titles for each field (case and punctuation are ignored; a title that starts with an alias also
        matches). Responses are linked to students by register number, then email. Unmapped questions are shown to evaluators as
        “Other details” unless listed under Ignore. Score columns are always ignored.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {FORM_FIELDS.map((f) => (
          <div key={f} className="space-y-1">
            <Label htmlFor={`map-${f}`}>{FORM_FIELD_LABELS[f]}</Label>
            <Input id={`map-${f}`} value={fields[f] ?? ""} onChange={(e) => setFields((s) => ({ ...s, [f]: e.target.value }))} />
          </div>
        ))}
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="map-ignore">Ignore (never shown or stored)</Label>
          <Input id="map-ignore" value={ignore} onChange={(e) => setIgnore(e.target.value)} placeholder="e.g. Parent Phone" />
        </div>
      </div>
      <Button onClick={save} disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <Save />} Save mapping
      </Button>
    </div>
  );
}

export function SheetColumnsForm({
  headers,
  headerError,
  criteria,
  writeback,
}: {
  headers: string[] | null;
  headerError: string | null;
  criteria: { id: string; name: string; sheet_column: string | null; is_active: boolean }[];
  writeback: { totalHeader: string; evaluatorHeader: string; domainsHeader: string };
}) {
  const [cols, setCols] = useState<Record<string, string>>(Object.fromEntries(criteria.map((c) => [c.id, c.sheet_column ?? c.name])));
  const [total, setTotal] = useState(writeback.totalHeader || (headers?.at(-1) ?? ""));
  const [evaluator, setEvaluator] = useState(writeback.evaluatorHeader);
  const [domains, setDomains] = useState(writeback.domainsHeader);
  const [pending, start] = useTransition();
  const present = new Set((headers ?? []).map(normalizeHeader));
  const found = (h: string) => !!h && present.has(normalizeHeader(h));

  const save = () =>
    start(async () => {
      const res = await saveSheetWriteback({
        totalHeader: total,
        evaluatorHeader: evaluator,
        domainsHeader: domains,
        criteria: criteria.map((c) => ({ id: c.id, sheetColumn: cols[c.id] ?? "" })),
      });
      if (res.ok) toast.success("Sheet columns saved. All evaluated rows will be re-written.");
      else toast.error(res.message);
    });

  const picker = (id: string, value: string, onChange: (v: string) => void, optional = false) =>
    headers ? (
      <select id={id} className={`${selectClass} w-full`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{optional ? "— don't write —" : "— choose a column —"}</option>
        {value && !headers.includes(value) && <option value={value}>{value} (not found)</option>}
        {headers.map((h, i) => (
          <option key={`${h}-${i}`} value={h}>
            {h || `(blank column ${i + 1})`}
          </option>
        ))}
      </select>
    ) : (
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={optional ? "Optional" : "Column header"} />
    );

  const mark = (h: string, optional = false) =>
    !h && optional ? null : found(h) ? (
      <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="Column found" />
    ) : (
      <XCircle className="size-4 shrink-0 text-destructive" aria-label="Column not found" />
    );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Choose the columns you added to the problem statement sheet. Each student&apos;s scores, the total and (optionally) the
        evaluator and domains are written into the row of their latest response, found by register number or email.
      </p>
      {headerError && <p className="text-sm text-destructive">{headerError}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {criteria.map((c) => (
          <div key={c.id} className="space-y-1">
            <Label htmlFor={`col-${c.id}`} className={c.is_active ? "" : "text-muted-foreground"}>
              {c.name}
              {!c.is_active && " (inactive)"}
            </Label>
            <div className="flex items-center gap-2">
              {picker(`col-${c.id}`, cols[c.id] ?? "", (v) => setCols((s) => ({ ...s, [c.id]: v })))}
              {headers && mark(cols[c.id] ?? "")}
            </div>
          </div>
        ))}
        <div className="space-y-1">
          <Label htmlFor="col-total">Total score column</Label>
          <div className="flex items-center gap-2">
            {picker("col-total", total, setTotal)}
            {headers && mark(total)}
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="col-evaluator">Evaluator name column</Label>
          <div className="flex items-center gap-2">
            {picker("col-evaluator", evaluator, setEvaluator, true)}
            {headers && mark(evaluator, true)}
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="col-domains">Domains column</Label>
          <div className="flex items-center gap-2">
            {picker("col-domains", domains, setDomains, true)}
            {headers && mark(domains, true)}
          </div>
        </div>
      </div>
      {criteria.length === 0 && <p className="text-sm text-muted-foreground">Add evaluation criteria first.</p>}
      <Button onClick={save} disabled={pending || !total}>
        {pending ? <Loader2 className="animate-spin" /> : <Save />} Save sheet columns
      </Button>
    </div>
  );
}
