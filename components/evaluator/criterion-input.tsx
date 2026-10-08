"use client";

import { Star } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { InputStyle } from "@/types/database";

interface Props {
  id: string;
  style: InputStyle;
  max: number;
  value: number | undefined;
  disabled?: boolean;
  onChange: (value: number | undefined) => void;
}

/** One criterion's score control, in the style the admin configured. */
export function CriterionInput({ id, style, max, value, disabled, onChange }: Props) {
  if (style === "STARS") {
    return (
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="flex flex-wrap items-center gap-0.5">
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => {
          const filled = value !== undefined && n <= value;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              aria-label={`${n} of ${max}`}
              disabled={disabled}
              onClick={() => onChange(value === n ? undefined : n)}
              className="rounded p-0.5 transition-transform hover:scale-110 disabled:cursor-not-allowed disabled:hover:scale-100"
            >
              <Star className={cn("size-7", filled ? "fill-warning text-warning" : "text-muted-foreground/40")} />
            </button>
          );
        })}
        <span className="ml-2 w-12 text-sm tabular-nums text-muted-foreground">
          {value ?? "–"}/{max}
        </span>
      </div>
    );
  }

  if (style === "SLIDER") {
    return (
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={0}
          max={max}
          step={1}
          value={value ?? 0}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-labelledby={`${id}-label`}
          aria-valuetext={value === undefined ? "Not scored" : `${value} of ${max}`}
          className={cn("h-2 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed", value === undefined && "opacity-50")}
        />
        <span className={cn("w-14 text-right text-sm font-semibold tabular-nums", value === undefined && "text-muted-foreground")}>
          {value ?? "–"}/{max}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        step={1}
        value={value ?? ""}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        onChange={(e) => {
          if (e.target.value === "") return onChange(undefined);
          const n = Math.trunc(Number(e.target.value));
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(0, n)));
        }}
        className="w-24"
      />
      <span className="text-sm text-muted-foreground">/ {max}</span>
    </div>
  );
}
