import { AppShell } from "@/components/shared/app-shell";
import type { NavItem } from "@/components/shared/sidebar-nav";
import { requireEvaluatorPage } from "@/lib/auth/session";
import { getSettings } from "@/lib/data/settings";

const NAV: NavItem[] = [
  { href: "/evaluator", label: "Dashboard", icon: "dashboard", exact: true },
  { href: "/evaluator/search", label: "Find Student", icon: "search" },
  { href: "/evaluator/evaluations", label: "My Evaluations", icon: "evaluations" },
  { href: "/evaluator/profile", label: "Profile", icon: "profile" },
];

export default async function EvaluatorLayout({ children }: LayoutProps<"/evaluator">) {
  const user = await requireEvaluatorPage();
  const settings = await getSettings();
  return (
    <AppShell nav={NAV} user={user} roleLabel="Evaluator" eventStatus={settings.event_status}>
      {children}
    </AppShell>
  );
}
