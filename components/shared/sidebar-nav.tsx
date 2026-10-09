"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Activity,
  BarChart3,
  ClipboardCheck,
  FileClock,
  GraduationCap,
  LayoutDashboard,
  ListChecks,
  Menu,
  RefreshCw,
  Search,
  Settings,
  Tags,
  Trophy,
  User,
  Users,
} from "lucide-react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { PoweredBy } from "./brand";
import { cn } from "@/lib/utils";

const ICONS = {
  dashboard: LayoutDashboard,
  students: GraduationCap,
  evaluators: Users,
  criteria: ListChecks,
  tags: Tags,
  search: Search,
  evaluations: ClipboardCheck,
  results: Trophy,
  sync: RefreshCw,
  audit: FileClock,
  settings: Settings,
  profile: User,
  activity: Activity,
  chart: BarChart3,
} as const;

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  exact?: boolean;
}

function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
            )}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SidebarNav({ items }: { items: NavItem[] }) {
  return <NavLinks items={items} />;
}

export function MobileNav({ items }: { items: NavItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        className="inline-flex size-9 items-center justify-center rounded-md hover:bg-muted lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="size-5" />
      </SheetTrigger>
      <SheetContent side="left" className="w-64 bg-sidebar p-0 text-sidebar-foreground">
        <SheetTitle className="px-5 pt-5 text-sidebar-accent-foreground">IDEA TO EXPO</SheetTitle>
        <NavLinks items={items} onNavigate={() => setOpen(false)} />
        <div className="border-t border-sidebar-border p-4">
          <PoweredBy glossy stacked logoHeight={26} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
