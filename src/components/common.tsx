import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = "default",
  hint,
}: {
  label: string;
  value: ReactNode;
  icon?: LucideIcon;
  tone?: "default" | "good" | "warn" | "bad" | "info";
  hint?: string;
}) {
  const tones = {
    default: "bg-slate-100 text-slate-700",
    good: "bg-emerald-100 text-emerald-700",
    warn: "bg-amber-100 text-amber-800",
    bad: "bg-rose-100 text-rose-700",
    info: "bg-sky-100 text-sky-700",
  };
  return (
    <div className="rounded-xl border bg-white p-4 shadow-xs">
      <div className="flex items-center justify-between">
        <span className="min-w-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        {Icon && (
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", tones[tone])}>
            <Icon className="size-4" aria-hidden />
          </span>
        )}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  PENDING: "bg-slate-100 text-slate-700 ring-slate-300",
  APPROVED: "bg-emerald-50 text-emerald-700 ring-emerald-300",
  CORRECTED: "bg-sky-50 text-sky-700 ring-sky-300",
  REJECTED: "bg-rose-50 text-rose-700 ring-rose-300",
  NEEDS_REVIEW: "bg-amber-50 text-amber-800 ring-amber-300",
  SUGGESTED: "bg-indigo-50 text-indigo-700 ring-indigo-300",
  SUSPECTED: "bg-amber-50 text-amber-800 ring-amber-300",
  INSUFFICIENT_EVIDENCE: "bg-orange-50 text-orange-800 ring-orange-300",
  CONFLICTING_EVIDENCE: "bg-rose-50 text-rose-700 ring-rose-300",
  EXCLUDED: "bg-slate-50 text-slate-500 ring-slate-200",
  REVIEWER_ADDED: "bg-teal-50 text-teal-700 ring-teal-300",
  QUEUED: "bg-slate-100 text-slate-700 ring-slate-300",
  RUNNING: "bg-sky-50 text-sky-700 ring-sky-300",
  PAUSED: "bg-amber-50 text-amber-800 ring-amber-300",
  COMPLETED: "bg-emerald-50 text-emerald-700 ring-emerald-300",
  COMPLETED_WITH_ERRORS: "bg-orange-50 text-orange-800 ring-orange-300",
  FAILED: "bg-rose-50 text-rose-700 ring-rose-300",
  CANCELLED: "bg-slate-50 text-slate-500 ring-slate-200",
  VERIFIED: "bg-emerald-50 text-emerald-700 ring-emerald-300",
  PENDING_VERIFICATION: "bg-slate-100 text-slate-700 ring-slate-300",
  UPLOADED: "bg-slate-100 text-slate-700 ring-slate-300",
  INDEXING: "bg-sky-50 text-sky-700 ring-sky-300",
  INDEXED: "bg-indigo-50 text-indigo-700 ring-indigo-300",
  RETIRED: "bg-slate-50 text-slate-500 ring-slate-200",
  correct: "bg-emerald-50 text-emerald-700 ring-emerald-300",
  false_positive: "bg-rose-50 text-rose-700 ring-rose-300",
  false_negative: "bg-orange-50 text-orange-800 ring-orange-300",
  incorrect_classification: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-300",
  unreviewed: "bg-slate-100 text-slate-600 ring-slate-300",
  uncertain: "bg-amber-50 text-amber-800 ring-amber-300",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap",
        STATUS_STYLE[status] ?? "bg-slate-100 text-slate-700 ring-slate-300",
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current opacity-70" />
      {status
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/^\w/, (c) => c.toUpperCase())}
    </span>
  );
}

export function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-white p-10 text-center">
      <Icon className="mb-3 size-8 text-muted-foreground" aria-hidden />
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function formatDate(d: string | Date | null | undefined, withTime = false): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  const iso = date.toISOString();
  return withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return "price not configured";
  return v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export const NativeSelectClass =
  "h-9 rounded-lg border border-input bg-white px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";
