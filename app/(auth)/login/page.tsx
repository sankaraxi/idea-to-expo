import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Lightbulb } from "lucide-react";
import { LoginForm } from "@/components/auth/login-form";
import { getSessionUser, homeFor } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const user = await getSessionUser();
  if (user && !(user.role === "EVALUATOR" && !user.evaluatorId)) redirect(homeFor(user));

  const next = typeof params.next === "string" ? params.next : "";
  const notice =
    params.error === "disabled" ? "Your evaluator account is disabled. Contact the event admin." : null;

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <section className="hidden flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-2 text-sidebar-accent-foreground">
          <Lightbulb className="size-6" />
          <span className="text-lg font-semibold tracking-tight">IDEA TO EXPO</span>
        </div>
        <div className="max-w-md space-y-3">
          <h2 className="text-3xl font-semibold leading-tight text-sidebar-accent-foreground">
            Ideathon evaluation portal
          </h2>
          <p className="text-sm text-sidebar-foreground/80">
            Review assigned submissions, score each idea from 1 to 10, and submit. Every evaluation is saved
            instantly and reported live.
          </p>
        </div>
        <p className="text-xs text-sidebar-foreground/60">Authorised evaluators and administrators only.</p>
      </section>

      <section className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-primary lg:hidden">
              <Lightbulb className="size-5" />
              <span className="font-semibold">IDEA TO EXPO</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Evaluator / Admin Login</h1>
            <p className="text-sm text-muted-foreground">Sign in with the credentials provided by the event team.</p>
          </div>
          <LoginForm next={next} notice={notice} />
        </div>
      </section>
    </main>
  );
}
