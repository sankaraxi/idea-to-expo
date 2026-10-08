import { AppShell } from "@/components/shared/app-shell";
import type { NavItem } from "@/components/shared/sidebar-nav";
import { requireAdminPage } from "@/lib/auth/session";
import { getSettings } from "@/lib/data/settings";

const NAV: NavItem[] = [
  { href: "/admin", label: "Dashboard", icon: "dashboard", exact: true },
  { href: "/admin/students", label: "Students", icon: "students" },
  { href: "/admin/evaluators", label: "Evaluators", icon: "evaluators" },
  { href: "/admin/allocation", label: "Allocation", icon: "allocation" },
  { href: "/admin/evaluations", label: "Evaluations", icon: "evaluations" },
  { href: "/admin/results", label: "Results", icon: "results" },
  { href: "/admin/sync", label: "Google Sheets Sync", icon: "sync" },
  { href: "/admin/audit-logs", label: "Audit Logs", icon: "audit" },
  { href: "/admin/settings", label: "Settings", icon: "settings" },
];

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const user = await requireAdminPage();
  const settings = await getSettings();
  return (
    <AppShell nav={NAV} user={user} roleLabel="Admin" eventStatus={settings.event_status}>
      {children}
    </AppShell>
  );
}
