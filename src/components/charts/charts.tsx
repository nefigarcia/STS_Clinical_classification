"use client";

import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/** Reference categorical palette (validated, light mode); slot 1 for single-series charts. */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
/** Reserved status colors — always shown with a text label. */
export const STATUS_COLORS: Record<string, string> = {
  APPROVED: "#1a7f37",
  CORRECTED: "#2a78d6",
  PENDING: "#8a8f98",
  NEEDS_REVIEW: "#c98500",
  REJECTED: "#cf222e",
};
const AXIS = { stroke: "#9aa0a6", fontSize: 12, tickLine: false, axisLine: false } as const;
const GRID = "#eceef1";

const tooltipStyle = { borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12, boxShadow: "0 4px 12px rgb(0 0 0 / 0.06)" };

export function HorizontalBars({ data, valueLabel }: { data: { label: string; n: number }[]; valueLabel: string }) {
  if (!data.length) return <p className="py-10 text-center text-sm text-muted-foreground">No data yet.</p>;
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 30 + 20)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 40, top: 4, bottom: 4 }} barCategoryGap={4}>
        <CartesianGrid horizontal={false} stroke={GRID} />
        <XAxis type="number" allowDecimals={false} {...AXIS} />
        <YAxis type="category" dataKey="label" width={170} {...AXIS} tick={{ fill: "#374151", fontSize: 12 }} />
        <Tooltip cursor={{ fill: "rgb(42 120 214 / 0.06)" }} contentStyle={tooltipStyle} formatter={(v) => [v, valueLabel]} />
        <Bar dataKey="n" fill={SERIES[0]} radius={[0, 4, 4, 0]} maxBarSize={18}>
          <LabelList dataKey="n" position="right" style={{ fill: "#374151", fontSize: 12 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function StatusBars({ data }: { data: { status: string; label: string; n: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ left: 0, right: 8, top: 16, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="label" {...AXIS} tick={{ fill: "#374151", fontSize: 12 }} />
        <YAxis allowDecimals={false} width={32} {...AXIS} />
        <Tooltip cursor={{ fill: "rgb(0 0 0 / 0.04)" }} contentStyle={tooltipStyle} formatter={(v) => [v, "Predictions"]} />
        <Bar dataKey="n" radius={[4, 4, 0, 0]} maxBarSize={44}>
          {data.map((d) => (
            <Cell key={d.status} fill={STATUS_COLORS[d.status] ?? SERIES[0]} />
          ))}
          <LabelList dataKey="n" position="top" style={{ fill: "#374151", fontSize: 12 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

const FORMATS = {
  plain: (v: number) => String(v),
  compact: (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)),
  usd: (v: number) => `$${v.toFixed(2)}`,
};

export function DailyLine({
  data,
  dataKey,
  label,
  format: formatName = "plain",
}: {
  data: Record<string, unknown>[];
  dataKey: string;
  label: string;
  format?: keyof typeof FORMATS;
}) {
  const format = FORMATS[formatName];
  if (!data.length) return <p className="py-10 text-center text-sm text-muted-foreground">No activity in the last 30 days.</p>;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="day" {...AXIS} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
        <YAxis width={48} {...AXIS} tickFormatter={(v: number) => (format ? format(v) : String(v))} />
        <Tooltip
          contentStyle={tooltipStyle}
          formatter={(v) => [format ? format(Number(v)) : v, label]}
          cursor={{ stroke: "#9aa0a6", strokeDasharray: "3 3" }}
        />
        <Line type="monotone" dataKey={dataKey} stroke={SERIES[0]} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, fill: "#fff" }} activeDot={{ r: 5 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
