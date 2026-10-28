"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search, SlidersHorizontal, X } from "lucide-react";
import { api } from "@/lib/client/fetch";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelectClass, StatusBadge, formatDate } from "@/components/common";
import { cn } from "@/lib/utils";

type Row = {
  encounterId: string;
  mrn: string;
  csn: string;
  firstDate: string | null;
  lastDate: string | null;
  noteCount: number;
  complications: string | null;
  statuses: string | null;
  pending: number;
};

const FILTERS = ["q", "mrn", "csn", "dos", "noteId", "complication", "status"] as const;
const col = createColumnHelper<Row>();

function overallStatus(r: Row): string {
  if (!r.statuses) return "UNPROCESSED";
  const s = r.statuses.split(",");
  if (s.includes("NEEDS_REVIEW")) return "NEEDS_REVIEW";
  if (s.includes("PENDING")) return "PENDING";
  if (s.every((x) => x === "REJECTED")) return "REJECTED";
  return "APPROVED";
}

export function PatientSearch({ defaultStatus }: { defaultStatus?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [data, setData] = useState<{ rows: Row[]; total: number }>({ rows: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [showAdvanced, setShowAdvanced] = useState(FILTERS.slice(1).some((f) => sp.get(f)));

  const page = Number(sp.get("page") ?? 1);
  const pageSize = Number(sp.get("pageSize") ?? 25);
  const sort = sp.get("sort") ?? "mrn";
  const dir = sp.get("dir") ?? "asc";
  const status = sp.get("status") ?? defaultStatus ?? "";
  const queryString = useMemo(() => {
    const p = new URLSearchParams(sp.toString());
    if (!p.has("status") && defaultStatus) p.set("status", defaultStatus);
    return p.toString();
  }, [sp, defaultStatus]);

  function update(patch: Record<string, string | null>, resetPage = true) {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    if (resetPage) p.delete("page");
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<{ rows: Row[]; total: number }>(`/api/patients?${queryString}`)
      .then((r) => {
        if (cancelled) return;
        setData(r);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  // Debounced free-text search.
  useEffect(() => {
    const t = setTimeout(() => (q !== (sp.get("q") ?? "") ? update({ q: q || null }) : undefined), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const back = encodeURIComponent(`${pathname}?${sp.toString()}`);
  const columns = useMemo(
    () => [
      col.accessor("mrn", { header: "MRN", meta: { sort: "mrn" }, cell: (c) => <span className="font-mono">{c.getValue()}</span> }),
      col.accessor("csn", { header: "CSN", meta: { sort: "csn" }, cell: (c) => <span className="font-mono">{c.getValue()}</span> }),
      col.accessor("firstDate", {
        header: "Date of Service",
        meta: { sort: "date" },
        cell: (c) => {
          const r = c.row.original;
          const a = formatDate(r.firstDate);
          const b = formatDate(r.lastDate);
          return <span className="whitespace-nowrap tabular-nums">{a === b ? a : `${a} → ${b}`}</span>;
        },
      }),
      col.accessor("noteCount", { header: "Notes", cell: (c) => <span className="tabular-nums">{c.getValue()}</span> }),
      col.accessor("complications", {
        header: "Complication",
        cell: (c) => <span className="line-clamp-2 max-w-md">{c.getValue() ?? <span className="text-muted-foreground">—</span>}</span>,
      }),
      col.display({ id: "status", header: "Status", meta: { sort: "status" }, cell: (c) => <StatusBadge status={overallStatus(c.row.original)} /> }),
      col.display({
        id: "action",
        header: "Action",
        cell: (c) => (
          <Link
            href={`/patients/${c.row.original.encounterId}?back=${back}`}
            className={buttonVariants({ size: "sm", variant: c.row.original.pending ? "default" : "outline" })}
          >
            {c.row.original.pending ? `Review (${c.row.original.pending})` : "Open"}
          </Link>
        ),
      }),
    ],
    [back],
  );

  const table = useReactTable({ data: data.rows, columns, getCoreRowModel: getCoreRowModel(), manualPagination: true, manualSorting: true });
  const pages = Math.max(1, Math.ceil(data.total / pageSize));

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-white p-4 shadow-xs">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search MRN, CSN, NOTE_ID or complication (partial match)"
            aria-label="Search encounters"
            className="h-12 pl-11 text-base"
            autoFocus
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select aria-label="Review status" className={NativeSelectClass} value={status} onChange={(e) => update({ status: e.target.value || null })}>
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="NEEDS_REVIEW">Needs review</option>
            <option value="APPROVED">Approved</option>
            <option value="CORRECTED">Corrected</option>
            <option value="REJECTED">Rejected</option>
            <option value="UNPROCESSED">Not processed</option>
          </select>
          <Button variant="outline" size="sm" onClick={() => setShowAdvanced((v) => !v)} aria-expanded={showAdvanced}>
            <SlidersHorizontal aria-hidden /> Filters
          </Button>
          {FILTERS.some((f) => sp.get(f)) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQ("");
                router.replace(pathname);
              }}
            >
              <X aria-hidden /> Clear
            </Button>
          )}
          <span className="ml-auto text-sm text-muted-foreground" aria-live="polite">
            {loading ? "Searching…" : `${data.total.toLocaleString()} encounter(s)`}
          </span>
        </div>
        {showAdvanced && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {(
              [
                ["mrn", "MRN"],
                ["csn", "CSN"],
                ["noteId", "NOTE_ID"],
                ["complication", "Complication"],
              ] as const
            ).map(([k, label]) => (
              <Input
                key={k}
                aria-label={label}
                placeholder={label}
                defaultValue={sp.get(k) ?? ""}
                onBlur={(e) => update({ [k]: e.target.value.trim() || null })}
                onKeyDown={(e) => e.key === "Enter" && update({ [k]: (e.target as HTMLInputElement).value.trim() || null })}
              />
            ))}
            <Input type="date" aria-label="Date of Service" defaultValue={sp.get("dos") ?? ""} onChange={(e) => update({ dos: e.target.value || null })} />
          </div>
        )}
      </div>

      {error && <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

      <div className="overflow-x-auto rounded-xl border bg-white shadow-xs">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const key = (h.column.columnDef.meta as { sort?: string } | undefined)?.sort;
                  const active = key === sort;
                  return (
                    <th
                      key={h.id}
                      scope="col"
                      className="px-3 py-2.5 font-medium text-slate-600"
                      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
                    >
                      {key ? (
                        <button
                          className="inline-flex items-center gap-1 hover:text-slate-900"
                          onClick={() => update({ sort: key, dir: active && dir === "asc" ? "desc" : "asc" }, false)}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {active ? (
                            dir === "asc" ? (
                              <ArrowUp className="size-3.5" aria-hidden />
                            ) : (
                              <ArrowDown className="size-3.5" aria-hidden />
                            )
                          ) : (
                            <ArrowUpDown className="size-3.5 opacity-40" aria-hidden />
                          )}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((r) => (
              <tr key={r.id} className="border-t hover:bg-slate-50">
                {r.getVisibleCells().map((c) => (
                  <td key={c.id} className="px-3 py-2 align-middle">
                    {flexRender(c.column.columnDef.cell, c.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {!loading && data.rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="p-8 text-center text-muted-foreground">
                  No encounters match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <label htmlFor="ps">Rows</label>
          <select id="ps" className={NativeSelectClass} value={pageSize} onChange={(e) => update({ pageSize: e.target.value })}>
            {[10, 25, 50, 100].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) }, false)} aria-label="Previous page">
            <ChevronLeft aria-hidden />
          </Button>
          <span className={cn("tabular-nums")}>
            Page {page} of {pages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => update({ page: String(page + 1) }, false)} aria-label="Next page">
            <ChevronRight aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}
