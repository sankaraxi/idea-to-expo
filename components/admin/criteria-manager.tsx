"use client";

import { useState, useTransition } from "react";
import { Loader2, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/shared/status-badge";
import { selectClass } from "@/components/shared/ui-bits";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { deleteCriterion, deleteDomain, saveCriterion, saveDomain } from "@/lib/actions/admin";
import type { CriterionRow, DomainRow, InputStyle } from "@/types/database";

const STYLE_LABELS: Record<InputStyle, string> = { STARS: "Stars", SLIDER: "Slider", NUMBER: "Number box" };

// ---------------------------------------------------------------------------
// Criteria
// ---------------------------------------------------------------------------

function CriterionDialog({ criterion, nextOrder, trigger }: { criterion?: CriterionRow; nextOrder: number; trigger: React.ReactElement }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [form, setForm] = useState({
    name: criterion?.name ?? "",
    description: criterion?.description ?? "",
    maxMarks: String(criterion?.max_marks ?? 10),
    inputStyle: criterion?.input_style ?? ("SLIDER" as InputStyle),
    sortOrder: String(criterion?.sort_order ?? nextOrder),
    isActive: criterion?.is_active ?? true,
    sheetColumn: criterion?.sheet_column ?? "",
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const starsTooMany = form.inputStyle === "STARS" && Number(form.maxMarks) > 10;

  const save = () =>
    start(async () => {
      const res = await saveCriterion({ ...form, id: criterion?.id, maxMarks: Number(form.maxMarks), sortOrder: Number(form.sortOrder) });
      if (!res.ok) return void toast.error(res.message);
      toast.success(criterion ? "Criterion updated." : "Criterion added.");
      setOpen(false);
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{criterion ? "Edit criterion" : "Add criterion"}</DialogTitle>
          <DialogDescription>Evaluators score every active criterion; the total is their sum.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="c-name">Name</Label>
            <Input id="c-name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Innovation" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="c-desc">Guidance for evaluators (optional)</Label>
            <Textarea id="c-desc" rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="c-max">Maximum marks</Label>
              <Input id="c-max" type="number" min={1} max={100} value={form.maxMarks} onChange={(e) => set("maxMarks", e.target.value)} aria-invalid={starsTooMany} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-style">Awarding style</Label>
              <select id="c-style" className={`${selectClass} h-8 w-full`} value={form.inputStyle} onChange={(e) => set("inputStyle", e.target.value as InputStyle)}>
                {Object.entries(STYLE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-order">Order</Label>
              <Input id="c-order" type="number" min={0} value={form.sortOrder} onChange={(e) => set("sortOrder", e.target.value)} />
            </div>
          </div>
          {starsTooMany && <p className="text-xs text-destructive">Stars support up to 10 marks. Use a slider or number box for larger maximums.</p>}
          <div className="space-y-1.5">
            <Label htmlFor="c-col">Problem statement sheet column header</Label>
            <Input id="c-col" value={form.sheetColumn} onChange={(e) => set("sheetColumn", e.target.value)} placeholder={form.name || "Defaults to the criterion name"} />
            <p className="text-xs text-muted-foreground">The score is written into the column with this header in the response sheet.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.isActive} onCheckedChange={(v) => set("isActive", v)} /> Active (shown to evaluators)
          </label>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={pending || starsTooMany || !form.name.trim()}>
            {pending && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CriteriaManager({ criteria, usage }: { criteria: CriterionRow[]; usage: Record<string, number> }) {
  const [pending, start] = useTransition();
  const nextOrder = criteria.reduce((m, c) => Math.max(m, c.sort_order + 1), 0);
  const activeMax = criteria.filter((c) => c.is_active).reduce((s, c) => s + c.max_marks, 0);

  const remove = (c: CriterionRow) => {
    if (!window.confirm(`Delete criterion “${c.name}”?`)) return;
    start(async () => {
      const res = await deleteCriterion(c.id);
      if (res.ok) toast.success("Criterion deleted.");
      else toast.error(res.message);
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Total marks (active criteria): <span className="font-semibold text-foreground">{activeMax}</span>
        </p>
        <CriterionDialog nextOrder={nextOrder} trigger={<Button><Plus /> Add criterion</Button>} />
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Criterion</TableHead>
              <TableHead className="text-right">Max</TableHead>
              <TableHead>Style</TableHead>
              <TableHead className="hidden md:table-cell">Sheet column</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {criteria.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No criteria yet. Add at least one before the event goes live.
                </TableCell>
              </TableRow>
            )}
            {criteria.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="tabular-nums text-muted-foreground">{c.sort_order}</TableCell>
                <TableCell>
                  <div className="font-medium">{c.name}</div>
                  {c.description && <div className="max-w-md truncate text-xs text-muted-foreground">{c.description}</div>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{c.max_marks}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1 text-sm">
                    {c.input_style === "STARS" && <Star className="size-3.5 fill-warning text-warning" />}
                    {STYLE_LABELS[c.input_style]}
                  </span>
                </TableCell>
                <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{c.sheet_column || c.name}</TableCell>
                <TableCell>
                  <StatusBadge status={c.is_active ? "ACTIVE" : "DISABLED"} />
                  {usage[c.id] ? <span className="ml-2 text-xs text-muted-foreground">{usage[c.id]} scores</span> : null}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <CriterionDialog criterion={c} nextOrder={nextOrder} trigger={<Button variant="ghost" size="icon-sm" aria-label="Edit criterion"><Pencil /></Button>} />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive"
                      onClick={() => remove(c)}
                      disabled={pending || !!usage[c.id]}
                      aria-label="Delete criterion"
                      title={usage[c.id] ? "Has scores — deactivate instead" : "Delete"}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export function DomainsManager({ domains, usage }: { domains: DomainRow[]; usage: Record<string, number> }) {
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const nextOrder = domains.reduce((m, d) => Math.max(m, d.sort_order + 1), 0);

  const add = () =>
    start(async () => {
      const res = await saveDomain({ name, sortOrder: nextOrder, isActive: true });
      if (!res.ok) return void toast.error(res.message);
      setName("");
      toast.success("Domain added.");
    });

  const toggle = (d: DomainRow) =>
    start(async () => {
      const res = await saveDomain({ id: d.id, name: d.name, sortOrder: d.sort_order, isActive: !d.is_active });
      if (!res.ok) toast.error(res.message);
    });

  const rename = (d: DomainRow) => {
    const next = window.prompt("Rename domain", d.name)?.trim();
    if (!next || next === d.name) return;
    start(async () => {
      const res = await saveDomain({ id: d.id, name: next, sortOrder: d.sort_order, isActive: d.is_active });
      if (!res.ok) toast.error(res.message);
    });
  };

  const remove = (d: DomainRow) => {
    if (!window.confirm(`Delete domain “${d.name}”?`)) return;
    start(async () => {
      const res = await deleteDomain(d.id);
      if (!res.ok) toast.error(res.message);
    });
  };

  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) add();
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GenAI, Blockchain, AI/ML, Full stack" className="max-w-sm" />
        <Button type="submit" disabled={pending || !name.trim()}>
          <Plus /> Add domain
        </Button>
      </form>
      {domains.length === 0 ? (
        <p className="text-sm text-muted-foreground">No domains yet. Evaluators tick the related domains as checkboxes.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {domains.map((d) => (
            <li key={d.id} className="flex items-center gap-1 rounded-full border bg-card py-1 pr-1 pl-3 text-sm">
              <span className={d.is_active ? "" : "text-muted-foreground line-through"}>{d.name}</span>
              {usage[d.id] ? <span className="text-xs text-muted-foreground">· {usage[d.id]}</span> : null}
              <Switch checked={d.is_active} onCheckedChange={() => toggle(d)} disabled={pending} aria-label={`${d.name} active`} className="ml-1 scale-75" />
              <Button variant="ghost" size="icon-xs" onClick={() => rename(d)} aria-label={`Rename ${d.name}`}>
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-destructive"
                onClick={() => remove(d)}
                disabled={pending || !!usage[d.id]}
                aria-label={`Delete ${d.name}`}
                title={usage[d.id] ? "Used by evaluations — deactivate instead" : "Delete"}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
