import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * Team SindhanAI branding. The logo file has generous transparent padding above
 * and below the wordmark, so it is shown in a fixed 5:1 box with object-cover,
 * which trims the padding evenly. The logo is dark navy + blue/purple, so it
 * must always sit on a white / light surface — use `glossy` on dark areas.
 */
export function SindhanaiLogo({ height = 28, className, priority = false }: { height?: number; className?: string; priority?: boolean }) {
  const width = height * 5;
  return (
    <span className={cn("relative inline-block shrink-0 overflow-hidden", className)} style={{ height, width }}>
      <Image src="/sindhanai-logo.png" alt="SindhanAI" fill sizes={`${width}px`} className="object-cover" priority={priority} />
    </span>
  );
}

/**
 * "Powered by" + the logo. `stacked` puts the caption above the logo.
 * `glossy` seats it on a glass-like light card (soft gradient, top sheen, diagonal
 * shine, inner highlight and drop shadow) so it reads on any sidebar colour.
 */
export function PoweredBy({
  logoHeight = 24,
  stacked = false,
  glossy = false,
  className,
  priority = false,
}: {
  logoHeight?: number;
  stacked?: boolean;
  glossy?: boolean;
  className?: string;
  priority?: boolean;
}) {
  const content = (
    <div className={cn("flex items-center gap-2", glossy ? "text-slate-500" : "text-muted-foreground", stacked ? "flex-col items-start gap-1" : "flex-wrap")}>
      <span className="text-[11px] font-medium tracking-wide uppercase">Powered by</span>
      <SindhanaiLogo height={logoHeight} priority={priority} />
    </div>
  );

  if (!glossy) return <div className={className}>{content}</div>;

  return (
    <div
      className={cn(
        "relative isolate overflow-hidden rounded-xl border border-white/70 px-3.5 py-3",
        // glass body: bright white fading to a faint indigo tint
        "bg-gradient-to-br from-white via-slate-50 to-indigo-100",
        // depth: soft drop shadow + 1px inner top highlight + faint inner bottom edge
        "shadow-[0_8px_20px_-8px_rgba(15,23,68,0.55),inset_0_1px_0_rgba(255,255,255,1),inset_0_-1px_0_rgba(99,102,241,0.18)]",
        // top sheen (the "gloss" band)
        "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:-z-10 before:h-1/2 before:bg-gradient-to-b before:from-white before:to-white/0",
        // diagonal shine streak
        "after:pointer-events-none after:absolute after:-top-6 after:-left-8 after:-z-10 after:h-24 after:w-10 after:rotate-[28deg] after:bg-gradient-to-r after:from-white/0 after:via-white/80 after:to-white/0",
        className,
      )}
    >
      {content}
    </div>
  );
}
