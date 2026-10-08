"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/** Completed evaluations by score percentage, in 10% buckets. */
export function PercentageDistributionChart({ distribution }: { distribution: Record<string, number> }) {
  const data = Array.from({ length: 10 }, (_, i) => ({
    bucket: i === 9 ? "90–100" : `${i * 10}–${i * 10 + 9}`,
    count: distribution[String(i)] ?? 0,
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="bucket" tickLine={false} axisLine={false} fontSize={11} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} />
        <Tooltip cursor={{ fill: "var(--muted)" }} formatter={(v) => [v, "Students"]} labelFormatter={(l) => `${l}%`} />
        <Bar dataKey="count" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DomainChart({ domains }: { domains: { domain: string; count: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, domains.length * 32 + 40)}>
      <BarChart data={domains} layout="vertical" margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke="var(--border)" />
        <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} />
        <YAxis type="category" dataKey="domain" width={100} tickLine={false} axisLine={false} fontSize={12} />
        <Tooltip cursor={{ fill: "var(--muted)" }} formatter={(v) => [v, "Ideas"]} />
        <Bar dataKey="count" fill="var(--chart-2)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DepartmentProgressChart({
  departments,
}: {
  departments: { department: string; students: number; completed: number }[];
}) {
  const data = departments.map((d) => ({ ...d, remaining: d.students - d.completed }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 34 + 40)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke="var(--border)" />
        <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} />
        <YAxis type="category" dataKey="department" width={90} tickLine={false} axisLine={false} fontSize={12} />
        <Tooltip cursor={{ fill: "var(--muted)" }} />
        <Bar dataKey="completed" stackId="a" name="Evaluated" fill="var(--chart-3)" />
        <Bar dataKey="remaining" stackId="a" name="Not yet" fill="var(--chart-4)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
