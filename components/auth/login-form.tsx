"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { login } from "@/lib/actions/auth";

export function LoginForm({ next, notice }: { next: string; notice: string | null }) {
  const [state, action, pending] = useActionState(login, null);
  const error = state && !state.ok ? state.message : notice;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <Button type="submit" className="h-10 w-full" disabled={pending}>
        {pending && <Loader2 className="animate-spin" />}
        Login
      </Button>
    </form>
  );
}
