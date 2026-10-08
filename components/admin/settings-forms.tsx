"use client";

import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { selectClass } from "@/components/shared/ui-bits";
import { saveFormMapping, saveSettings } from "@/lib/actions/admin";
import { FORM_FIELDS, FORM_FIELD_LABELS, type FormFieldMapping } from "@/lib/forms/mapping";

export function EvaluationSettingsForm({
  allowResubmission,
  tieBreakers,
  options,
}: {
  allowResubmission: boolean;
  tieBreakers: string[];
  options: { id: string; label: string }[];
}) {
  const [allow, setAllow] = useState(allowResubmission);
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
      const res = await saveSettings({ allowResubmission: allow, tieBreakers: rules });
      if (res.ok) toast.success("Settings saved.");
      else toast.error(res.message);
    });

  return (
    <div className="space-y-6">
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
        <Label>Tie-break rules (after average score, in order)</Label>
        <ol className="space-y-1.5">
          {rules.map((id, i) => (
            <li key={id} className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm">
              <span className="w-5 text-muted-foreground">{i + 1}.</span>
              <span className="flex-1">{label(id)}</span>
              <Button variant="ghost" size="icon-xs" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp /></Button>
              <Button variant="ghost" size="icon-xs" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown /></Button>
              <Button variant="ghost" size="icon-xs" onClick={() => setRules((r) => r.filter((x) => x !== id))} aria-label="Remove"><X /></Button>
            </li>
          ))}
          {rules.length === 0 && <li className="text-sm text-muted-foreground">No tie-breakers: equal averages share a rank.</li>}
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
              <option key={o.id} value={o.id}>{o.label}</option>
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
  const split = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

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
        Comma-separated Google Form question titles for each portal field (case and punctuation are ignored). Unmapped
        questions are kept as “Other details” and shown to evaluators — list private questions under “Ignore”.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {FORM_FIELDS.map((f) => (
          <div key={f} className="space-y-1">
            <Label htmlFor={`map-${f}`}>
              {FORM_FIELD_LABELS[f]}
              {(f === "register_number" || f === "name") && <span className="text-destructive"> *</span>}
            </Label>
            <Input id={`map-${f}`} value={fields[f] ?? ""} onChange={(e) => setFields((s) => ({ ...s, [f]: e.target.value }))} />
          </div>
        ))}
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="map-ignore">Ignore (never stored in other details)</Label>
          <Input id="map-ignore" value={ignore} onChange={(e) => setIgnore(e.target.value)} placeholder="e.g. Aadhaar Number, Parent Phone" />
        </div>
      </div>
      <Button onClick={save} disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <Plus />} Save mapping
      </Button>
    </div>
  );
}
