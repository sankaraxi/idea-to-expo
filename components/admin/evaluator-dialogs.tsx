"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { KeyRound, Loader2, Pencil, Plus, Power } from "lucide-react";
import { toast } from "sonner";
import { z } from "zod";
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
import { createEvaluator, resetEvaluatorPassword, setEvaluatorActive, updateEvaluator } from "@/lib/actions/admin";
import type { EvaluatorProgressRow } from "@/types/database";

const formSchema = z.object({
  name: z.string().trim().min(2, "Name is required"),
  email: z.email("Enter a valid email"),
  employeeId: z.string().trim().max(50),
  department: z.string().trim().max(120),
  password: z.string(),
});
type FormValues = z.infer<typeof formSchema>;

function EvaluatorForm({
  defaults,
  mode,
  onDone,
}: {
  defaults: Partial<FormValues> & { id?: string };
  mode: "create" | "edit";
  onDone: () => void;
}) {
  const [pending, start] = useTransition();
  const form = useForm<FormValues>({
    resolver: zodResolver(
      mode === "create"
        ? formSchema.extend({ password: z.string().min(8, "At least 8 characters").max(72) })
        : formSchema,
    ),
    defaultValues: { name: "", email: "", employeeId: "", department: "", password: "", ...defaults },
  });
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit((values) =>
    start(async () => {
      const result =
        mode === "create" ? await createEvaluator(values) : await updateEvaluator({ ...values, id: defaults.id });
      if (!result.ok) {
        toast.error(result.message);
        for (const [field, messages] of Object.entries(result.fieldErrors ?? {})) {
          form.setError(field as keyof FormValues, { message: messages[0] });
        }
        return;
      }
      toast.success(mode === "create" ? "Evaluator created." : "Evaluator updated.");
      onDone();
    }),
  );

  const field = (name: keyof FormValues, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={`ev-${name}`}>{label}</Label>
      <Input id={`ev-${name}`} aria-invalid={!!errors[name]} {...form.register(name)} {...props} />
      {errors[name] && <p className="text-xs text-destructive">{errors[name]?.message}</p>}
    </div>
  );

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {field("name", "Name")}
      {field("email", "Email (login)", { type: "email", autoComplete: "off" })}
      <div className="grid grid-cols-2 gap-3">
        {field("employeeId", "Employee ID")}
        {field("department", "Department")}
      </div>
      {mode === "create" && field("password", "Initial password", { type: "password", autoComplete: "new-password" })}
      <DialogFooter>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          {mode === "create" ? "Create evaluator" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function CreateEvaluatorButton() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus /> Add evaluator
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add evaluator</DialogTitle>
          <DialogDescription>Creates a login. Share the email and initial password with the evaluator.</DialogDescription>
        </DialogHeader>
        <EvaluatorForm mode="create" defaults={{}} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

export function EvaluatorRowActions({ row }: { row: EvaluatorProgressRow }) {
  const [editOpen, setEditOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [pending, start] = useTransition();
  const active = row.status === "ACTIVE";

  const toggle = () => {
    const drafts = Number(row.in_progress_count);
    const message = active
      ? `Disable ${row.name}? They lose access immediately.${drafts ? ` They have ${drafts} unsubmitted draft(s) — release them from the Evaluations page so other evaluators can take those students.` : ""}`
      : `Re-enable ${row.name}?`;
    if (!window.confirm(message)) return;
    start(async () => {
      const result = await setEvaluatorActive(row.evaluator_id, !active);
      if (result.ok) toast.success(active ? "Evaluator disabled." : "Evaluator enabled.");
      else toast.error(result.message);
    });
  };

  const reset = () =>
    start(async () => {
      const result = await resetEvaluatorPassword(row.evaluator_id, password);
      if (result.ok) {
        toast.success("Password reset.");
        setPwOpen(false);
        setPassword("");
      } else toast.error(result.message);
    });

  return (
    <div className="flex justify-end gap-1">
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Edit evaluator" />}>
          <Pencil />
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit evaluator</DialogTitle>
          </DialogHeader>
          <EvaluatorForm
            mode="edit"
            defaults={{
              id: row.evaluator_id,
              name: row.name,
              email: row.email,
              employeeId: row.employee_id ?? "",
              department: row.department ?? "",
            }}
            onDone={() => setEditOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={pwOpen} onOpenChange={setPwOpen}>
        <DialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Reset password" />}>
          <KeyRound />
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset password for {row.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`pw-${row.evaluator_id}`}>New password</Label>
            <Input id={`pw-${row.evaluator_id}`} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <DialogFooter>
            <Button onClick={reset} disabled={pending || password.length < 8}>
              Reset password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={toggle}
        disabled={pending}
        aria-label={active ? "Disable evaluator" : "Enable evaluator"}
        className={active ? "text-destructive" : "text-success"}
      >
        <Power />
      </Button>
    </div>
  );
}
