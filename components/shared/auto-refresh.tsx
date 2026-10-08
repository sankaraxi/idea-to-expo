"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Re-renders server data on an interval while the tab is visible (live dashboards). */
export function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") {
        router.refresh();
        setUpdatedAt(new Date());
      }
    };
    const id = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, intervalMs]);

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-1.5 animate-pulse rounded-full bg-success" />
      Live{updatedAt ? ` · updated ${updatedAt.toLocaleTimeString()}` : ""}
    </span>
  );
}
