"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export function ScoreDistributionChart({ distribution }: { distribution: Record<string, number> }) {
  const data = Array.from({ length: 10 }, (_, i) => ({ score: String(i + 1), count: distribution[String(i + 1)] ?? 0 }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="score" tickLine={false} axisLine={false} fontSize={12} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} />
        <Tooltip cursor={{ fill: "var(--muted)" }} formatter={(v) => [v, "Evaluations"]} labelFormatter={(l) => `Score ${l}`} />
        <Bar dataKey="count" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DepartmentProgressChart({
  departments,
}: {
  departments: { department: string; assigned: number; completed: number }[];
}) {
  const data = departments.map((d) => ({ ...d, pending: d.assigned - d.completed }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 34 + 40)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke="var(--border)" />
        <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} />
        <YAxis type="category" dataKey="department" width={90} tickLine={false} axisLine={false} fontSize={12} />
        <Tooltip cursor={{ fill: "var(--muted)" }} />
        <Bar dataKey="completed" stackId="a" name="Completed" fill="var(--chart-3)" />
        <Bar dataKey="pending" stackId="a" name="Pending" fill="var(--chart-4)" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
