"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type Highlight = { start: number; end: number; id: string; kind: "evidence" | "focus" };

/** Render note text with evidence highlights and in-note search matches. Text is rendered as text (never HTML). */
export function NoteViewer({ text, highlights, focusId }: { text: string; highlights: Highlight[]; focusId: string | null }) {
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const container = useRef<HTMLDivElement>(null);

  const searchRanges = useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return [];
    const out: { start: number; end: number }[] = [];
    const lower = text.toLowerCase();
    let i = lower.indexOf(q.toLowerCase());
    while (i >= 0 && out.length < 500) {
      out.push({ start: i, end: i + q.length });
      i = lower.indexOf(q.toLowerCase(), i + q.length);
    }
    return out;
  }, [text, query]);

  const segments = useMemo(() => {
    const points = new Set<number>([0, text.length]);
    const valid = highlights.filter((h) => h.start >= 0 && h.end <= text.length && h.end > h.start);
    for (const h of [...valid, ...searchRanges]) {
      points.add(h.start);
      points.add(h.end);
    }
    const sorted = [...points].sort((a, b) => a - b);
    const segs: { start: number; end: number; hl: Highlight | null; match: number }[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const [s, e] = [sorted[i], sorted[i + 1]];
      const cover = valid.filter((h) => h.start <= s && h.end >= e);
      const hl = cover.find((h) => h.id === focusId) ?? cover[0] ?? null;
      const match = searchRanges.findIndex((r) => r.start <= s && r.end >= e);
      segs.push({ start: s, end: e, hl, match });
    }
    return segs;
  }, [text, highlights, searchRanges, focusId]);

  useEffect(() => {
    const el = container.current?.querySelector(`[data-hl="${focusId}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusId, text]);

  useEffect(() => {
    const el = container.current?.querySelector(`[data-match="${matchIdx}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [matchIdx, searchRanges]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={query}
          onChange={(e) => (setQuery(e.target.value), setMatchIdx(0))}
          onKeyDown={(e) => e.key === "Enter" && searchRanges.length && setMatchIdx((m) => (m + 1) % searchRanges.length)}
          placeholder="Search within note (Enter = next)"
          aria-label="Search within note"
          className="pl-8"
        />
        {query.trim().length >= 2 && (
          <span className="absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground" aria-live="polite">
            {searchRanges.length ? `${matchIdx + 1}/${searchRanges.length}` : "0"}
          </span>
        )}
      </div>
      <div
        ref={container}
        tabIndex={0}
        aria-label="Clinical note text"
        className="min-h-0 flex-1 overflow-auto rounded-lg border bg-white p-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap"
      >
        {segments.map((s, i) => {
          const t = text.slice(s.start, s.end);
          if (!s.hl && s.match < 0) return <span key={i}>{t}</span>;
          return (
            <mark
              key={i}
              data-hl={s.hl?.id}
              data-match={s.match >= 0 ? s.match : undefined}
              className={cn(
                "rounded-sm px-0.5",
                s.hl && (s.hl.id === focusId ? "bg-amber-300 ring-2 ring-amber-500" : "bg-amber-100"),
                s.match >= 0 && (s.match === matchIdx ? "bg-sky-300" : "bg-sky-100"),
              )}
            >
              {t}
            </mark>
          );
        })}
      </div>
    </div>
  );
}
