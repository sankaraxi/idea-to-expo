import Link from "next/link";
import { Lightbulb, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logout } from "@/lib/actions/auth";
import type { EventStatus } from "@/types/database";
import { PoweredBy, SindhanaiLogo } from "./brand";
import { EventStatusBadge } from "./event-status-badge";
import { MobileNav, SidebarNav, type NavItem } from "./sidebar-nav";

export function AppShell({
  nav,
  user,
  roleLabel,
  eventStatus,
  children,
}: {
  nav: NavItem[];
  user: { name: string; email: string };
  roleLabel: string;
  eventStatus: EventStatus;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
        <Link href={nav[0].href} className="flex h-14 items-center gap-2 px-5 text-sidebar-accent-foreground">
          <Lightbulb className="size-5" />
          <span className="font-semibold tracking-tight">IDEA TO EXPO</span>
        </Link>
        <SidebarNav items={nav} />
        <div className="border-t border-sidebar-border p-4">
          <PoweredBy glossy stacked logoHeight={26} />
        </div>
        <div className="border-t border-sidebar-border p-4 text-xs">
          <p className="truncate font-medium text-sidebar-accent-foreground">{user.name}</p>
          <p className="truncate text-sidebar-foreground/70">{user.email}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-card/95 px-4 backdrop-blur lg:px-6">
          <MobileNav items={nav} />
          <span className="font-semibold text-primary lg:hidden">IDEA TO EXPO</span>
          <SindhanaiLogo height={22} className="hidden sm:inline-block lg:hidden" />
          <div className="ml-auto flex items-center gap-3">
            <EventStatusBadge status={eventStatus} />
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {roleLabel} · <span className="text-foreground">{user.name}</span>
            </span>
            <form action={logout}>
              <Button variant="ghost" size="sm" type="submit" aria-label="Sign out">
                <LogOut />
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            </form>
          </div>
        </header>
        <main className="flex-1 p-4 lg:p-6">{children}</main>
        <footer className="border-t bg-card px-4 py-3 lg:px-6">
          <PoweredBy logoHeight={20} />
        </footer>
      </div>
    </div>
  );
}
