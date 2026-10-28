"use client";

import { useMemo, useState } from "react";
import { useApi } from "@/hooks/use-api";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, BookOpen, ChevronLeft, ChevronRight, FileText, Loader2, RefreshCw, ShieldQuestion, Sparkles } from "lucide-react";
import { api } from "@/lib/client/fetch";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge, formatDate } from "@/components/common";
import { NoteViewer, type Highlight } from "./note-viewer";
import { AddMissingForm, DecisionPanel, type PanelPrediction } from "./decision-panel";
import { cn } from "@/lib/utils";

type Evidence = {
  id: string;
  clinicalNoteId: string;
  evidenceText: string;
  evidenceStart: number | null;
  evidenceEnd: number | null;
  verified: boolean;
  evidenceType: string;
  clinicalNote: { noteId: string; noteType: string | null; dateOfService: string | null };
};
type Prediction = PanelPrediction & {
  classificationStatus: string;
  eventAssertion: string | null;
  evidenceStatus: string;
  finalComplication: string | null;
  finalStsCode: string | null;
  complicationEventDate: string | null;
  confidenceScore: number | null;
  uncertainty: string | null;
  aiExplanation: string | null;
  validationIssues: string[] | null;
  modelVersion: string | null;
  promptVersion: string | null;
  escalated: boolean;
  manualPage: number | null;
  manualSection: string | null;
  manualVersion: { version: string } | null;
  manualReference: {
    id: string;
    sectionName: string | null;
    pageNumber: number;
    longName: string | null;
    stsCode: string | null;
    complicationName: string | null;
  } | null;
  evidence: Evidence[];
};
type Detail = {
  encounter: { id: string; mrn: string; csn: string; surgeryDate: string | null; surgeryDateSource: string };
  notes: { id: string; noteId: string; noteType: string | null; dateOfService: string | null; length: number; sourceFlag: string | null }[];
  predictions: Prediction[];
  examples: { id: string; complication: string; clinicalEvidence: string | null }[];
  neighbors: { prev: string | null; next: string | null; position: number; total: number };
  lastRun: { createdAt: string; model: string; manualVersion: string; promptVersion: string } | null;
};
type NotePayload = {
  note: { id: string; noteId: string; noteType: string | null; dateOfService: string | null; combinedNoteText: string };
  evidence: { id: string; evidenceStart: number | null; evidenceEnd: number | null; predictionId: string }[];
};

export function ReviewWorkspace({ encounterId, canReview, back }: { encounterId: string; canReview: boolean; back: string | null }) {
  const router = useRouter();
  // The page keys this component by encounter id, so state starts fresh per encounter.
  const { data: detail, error, reload: load } = useApi<Detail>(`/api/patients/${encounterId}`);
  const [pickedNote, setNoteId] = useState<string | null>(null);
  const [pickedPred, setSelectedPred] = useState<string | null>(null);
  const [focusEvidence, setFocusEvidence] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);
  const [noteFilter, setNoteFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedPred =
    pickedPred ??
    detail?.predictions.find((p) => p.classificationStatus !== "EXCLUDED" && ["PENDING", "NEEDS_REVIEW"].includes(p.reviewStatus))?.id ??
    detail?.predictions[0]?.id ??
    null;
  const noteId = pickedNote ?? detail?.predictions.flatMap((p) => p.evidence)[0]?.clinicalNoteId ?? detail?.notes[0]?.id ?? null;
  const { data: note } = useApi<NotePayload>(noteId ? `/api/patients/${encounterId}/notes/${noteId}` : null);

  const highlights: Highlight[] = useMemo(
    () =>
      (note?.evidence ?? [])
        .filter((e) => e.evidenceStart !== null && e.evidenceEnd !== null)
        .map((e) => ({ id: e.id, start: e.evidenceStart!, end: e.evidenceEnd!, kind: "evidence" as const })),
    [note],
  );

  async function rerun(secondOpinion: boolean) {
    setBusy(true);
    try {
      await api(`/api/classifications/${encounterId}`, { method: "POST", json: { secondOpinion } });
      toast.success(secondOpinion ? "Second AI evaluation queued (escalation model)" : "Re-classification queued");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSurgeryDate(v: string) {
    try {
      await api(`/api/patients/${encounterId}`, { method: "PATCH", json: { surgeryDate: v || null } });
      toast.success("Surgery date confirmed");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (error) return <p className="rounded-md bg-destructive/10 p-4 text-destructive">{error}</p>;
  if (!detail)
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading encounter…
      </p>
    );

  const active = detail.predictions.filter((p) => p.classificationStatus !== "EXCLUDED");
  const excluded = detail.predictions.filter((p) => p.classificationStatus === "EXCLUDED");
  const selected = detail.predictions.find((p) => p.id === selectedPred) ?? null;
  const currentNoteMeta = detail.notes.find((n) => n.id === noteId) ?? null;
  const filteredNotes = detail.notes.filter(
    (n) => !noteFilter || `${n.noteId} ${n.noteType ?? ""} ${n.dateOfService ?? ""}`.toLowerCase().includes(noteFilter.toLowerCase()),
  );
  const evidenceNoteIds = new Set(detail.predictions.flatMap((p) => p.evidence.map((e) => e.clinicalNoteId)));
  const nav = (id: string | null) => id && router.push(`/patients/${id}${back ? `?back=${encodeURIComponent(back)}` : ""}`);

  return (
    <div className="flex h-[calc(100vh-7.5rem)] min-h-[600px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-white px-4 py-3 shadow-xs">
        <Link href={back ?? "/patients"} className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ArrowLeft aria-hidden /> Back to results
        </Link>
        <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
          <div>
            <dt className="inline text-muted-foreground">MRN </dt>
            <dd className="inline font-mono font-medium">{detail.encounter.mrn}</dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">CSN </dt>
            <dd className="inline font-mono font-medium">{detail.encounter.csn}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-muted-foreground">Surgery date</dt>
            <dd>
              {canReview ? (
                <Input
                  type="date"
                  className="h-7 w-36"
                  defaultValue={detail.encounter.surgeryDate?.slice(0, 10) ?? ""}
                  onBlur={(e) => e.target.value !== (detail.encounter.surgeryDate?.slice(0, 10) ?? "") && saveSurgeryDate(e.target.value)}
                  aria-label="Surgery date"
                />
              ) : (
                formatDate(detail.encounter.surgeryDate)
              )}
            </dd>
            {detail.encounter.surgeryDateSource !== "MANUAL" && (
              <span
                className="rounded bg-amber-100 px-1.5 text-[11px] text-amber-900"
                title="Derived from the earliest operative note; selects the STS manual version"
              >
                {detail.encounter.surgeryDateSource === "UNKNOWN" ? "unknown" : "derived — confirm"}
              </span>
            )}
          </div>
        </dl>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {canReview && (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => rerun(false)}>
                <RefreshCw aria-hidden /> Re-run AI
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => rerun(true)} title="Ask the escalation model for a second evaluation">
                <ShieldQuestion aria-hidden /> Second opinion
              </Button>
            </>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            {detail.neighbors.position}/{detail.neighbors.total}
          </span>
          <Button size="sm" variant="outline" disabled={!detail.neighbors.prev} onClick={() => nav(detail.neighbors.prev)} aria-label="Previous record">
            <ChevronLeft aria-hidden /> Prev
          </Button>
          <Button size="sm" variant="outline" disabled={!detail.neighbors.next} onClick={() => nav(detail.neighbors.next)} aria-label="Next record">
            Next <ChevronRight aria-hidden />
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_320px]">
        {/* Left: clinical documentation */}
        <section aria-label="Clinical documentation" className="flex min-h-0 flex-col rounded-xl border bg-white p-3 shadow-xs">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <FileText className="size-4" aria-hidden /> Clinical notes ({detail.notes.length})
            </h2>
            <Input
              value={noteFilter}
              onChange={(e) => setNoteFilter(e.target.value)}
              placeholder="Filter notes"
              aria-label="Filter notes"
              className="h-7 w-40"
            />
          </div>
          <div className="mb-2 max-h-36 overflow-auto rounded-lg border">
            <ul role="listbox" aria-label="Notes in this encounter">
              {filteredNotes.map((n) => (
                <li key={n.id}>
                  <button
                    role="option"
                    aria-selected={n.id === noteId}
                    onClick={() => (setNoteId(n.id), setFocusEvidence(null))}
                    className={cn("flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-slate-50", n.id === noteId && "bg-primary/10")}
                  >
                    {evidenceNoteIds.has(n.id) && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" title="Cited as evidence" />}
                    <span className="font-mono">{n.noteId}</span>
                    <span className="truncate">{n.noteType}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{formatDate(n.dateOfService, true)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {currentNoteMeta && (
            <dl className="mb-2 grid grid-cols-2 gap-x-3 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">NOTE_ID</dt>
                <dd className="font-mono">{currentNoteMeta.noteId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Type</dt>
                <dd>{currentNoteMeta.noteType ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Date of Service</dt>
                <dd>{formatDate(currentNoteMeta.dateOfService, true)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Length</dt>
                <dd>{currentNoteMeta.length.toLocaleString()} chars</dd>
              </div>
            </dl>
          )}
          {note && note.note.id === noteId ? (
            <NoteViewer text={note.note.combinedNoteText} highlights={highlights} focusId={focusEvidence} />
          ) : (
            <p className="text-sm text-muted-foreground">Loading note…</p>
          )}
        </section>

        {/* Middle: AI suggestions */}
        <section aria-label="AI suggested complications" className="min-h-0 overflow-auto rounded-xl border bg-slate-50 p-3 shadow-xs">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Sparkles className="size-4" aria-hidden /> AI suggested complications ({active.length})
            </h2>
            {detail.lastRun && (
              <span className="text-[11px] text-muted-foreground">
                {detail.lastRun.model} · TM {detail.lastRun.manualVersion} · prompt {detail.lastRun.promptVersion}
              </span>
            )}
          </div>
          {active.length === 0 && (
            <p className="rounded-lg border border-dashed bg-white p-4 text-sm text-muted-foreground">
              {detail.lastRun
                ? "The AI found no supported complications for this encounter. Reviewers can still add a missing complication."
                : "This encounter has not been processed by the AI yet."}
            </p>
          )}
          <div className="space-y-3">
            {active.map((p) => (
              <PredictionCard
                key={p.id}
                p={p}
                selected={p.id === selectedPred}
                onSelect={() => setSelectedPred(p.id)}
                onEvidence={(ev) => {
                  setSelectedPred(p.id);
                  setNoteId(ev.clinicalNoteId);
                  setFocusEvidence(ev.id);
                }}
                examples={detail.examples.filter((e) => e.complication.toLowerCase().includes(p.predictedComplication.split(/[\s,]/)[0].toLowerCase()))}
              />
            ))}
          </div>
          {excluded.length > 0 && (
            <div className="mt-4">
              <button className="text-xs font-medium text-muted-foreground underline" onClick={() => setShowExcluded((v) => !v)} aria-expanded={showExcluded}>
                {showExcluded ? "Hide" : "Show"} {excluded.length} event(s) the AI considered and excluded (negated, historical, planned, out of window)
              </button>
              {showExcluded && (
                <div className="mt-2 space-y-2 opacity-80">
                  {excluded.map((p) => (
                    <PredictionCard
                      key={p.id}
                      p={p}
                      selected={p.id === selectedPred}
                      onSelect={() => setSelectedPred(p.id)}
                      onEvidence={(ev) => (setNoteId(ev.clinicalNoteId), setFocusEvidence(ev.id))}
                      examples={[]}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Right: reviewer decision */}
        <section aria-label="Reviewer decision" className="min-h-0 space-y-4 overflow-auto rounded-xl border bg-white p-3 shadow-xs">
          <h2 className="text-sm font-semibold">Reviewer decision</h2>
          <DecisionPanel prediction={selected} canReview={canReview} onSaved={load} />
          {canReview && (
            <AddMissingForm
              encounterId={encounterId}
              currentNoteId={noteId}
              currentNoteLabel={currentNoteMeta ? `NOTE_ID ${currentNoteMeta.noteId}` : null}
              onSaved={load}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function PredictionCard({
  p,
  selected,
  onSelect,
  onEvidence,
  examples,
}: {
  p: Prediction;
  selected: boolean;
  onSelect: () => void;
  onEvidence: (e: Evidence) => void;
  examples: Detail["examples"];
}) {
  const unverified = p.evidence.filter((e) => !e.verified).length;
  const incomplete = p.evidence.length === 0 || unverified > 0 || (p.validationIssues?.length ?? 0) > 0 || p.evidenceStatus !== "supported";
  return (
    <article
      onClick={onSelect}
      className={cn("cursor-pointer rounded-lg border bg-white p-3 shadow-xs transition-shadow hover:shadow-sm", selected && "ring-2 ring-primary")}
      aria-current={selected}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">
            {p.finalComplication && p.finalComplication !== p.predictedComplication ? (
              <>
                <s className="text-muted-foreground">{p.predictedComplication}</s> → {p.finalComplication}
              </>
            ) : (
              p.predictedComplication
            )}
          </h3>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span>
              STS code: <span className="font-mono text-foreground">{p.finalStsCode ?? p.stsCode ?? "not verified"}</span>
            </span>
            {p.complicationEventDate && <span>Event: {formatDate(p.complicationEventDate)}</span>}
            {p.eventAssertion && <span>Assertion: {p.eventAssertion.replace("_", " ")}</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusBadge status={p.reviewStatus} />
          <StatusBadge status={p.classificationStatus} />
        </div>
      </div>
      {incomplete && p.classificationStatus !== "EXCLUDED" && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 p-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Evidence incomplete: {p.evidence.length === 0 ? "no source evidence. " : ""}
            {unverified > 0 ? `${unverified} excerpt(s) not found verbatim in the note. ` : ""}
            {(p.validationIssues ?? []).join("; ")}
          </span>
        </p>
      )}
      {p.evidence.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {p.evidence.map((e) => (
            <li key={e.id}>
              <button
                onClick={(ev) => (ev.stopPropagation(), onEvidence(e))}
                className="w-full rounded-md border-l-4 border-amber-400 bg-amber-50/60 p-2 text-left text-xs hover:bg-amber-50"
              >
                <span className="mb-0.5 block text-[11px] text-muted-foreground">
                  NOTE_ID <span className="font-mono">{e.clinicalNote.noteId}</span> · {e.clinicalNote.noteType} · {formatDate(e.clinicalNote.dateOfService)}{" "}
                  {!e.verified && <span className="font-semibold text-rose-700">· unverified</span>}
                </span>
                “{e.evidenceText}”
              </button>
            </li>
          ))}
        </ul>
      )}
      {p.aiExplanation && <p className="mt-2 text-sm">{p.aiExplanation}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {p.manualReference ? (
          <Link
            onClick={(e) => e.stopPropagation()}
            href={`/knowledge-base?rule=${p.manualReference.id}`}
            className="inline-flex items-center gap-1 text-primary underline"
            target="_blank"
          >
            <BookOpen className="size-3.5" aria-hidden /> STS TM {p.manualVersion?.version} · {p.manualSection ?? p.manualReference.longName ?? "section"} · p.
            {p.manualPage}
          </Link>
        ) : (
          p.modelVersion !== "reviewer" && <span className="text-rose-700">No STS manual reference</span>
        )}
        <span>
          Model: {p.modelVersion}
          {p.escalated && " (escalated)"}
        </span>
        {p.confidenceScore !== null && (
          <span title="Model self-reported; not a calibrated clinical probability">
            Self-reported confidence {Math.round(p.confidenceScore * 100)}% (uncalibrated)
          </span>
        )}
        {p.uncertainty && <span>Uncertainty: {p.uncertainty}</span>}
      </div>
      {examples.length > 0 && (
        <details className="mt-2 text-xs" onClick={(e) => e.stopPropagation()}>
          <summary className="cursor-pointer text-muted-foreground">Similar validated examples ({examples.length})</summary>
          <ul className="mt-1 space-y-1">
            {examples.slice(0, 3).map((x) => (
              <li key={x.id} className="rounded bg-slate-50 p-1.5">
                <span className="font-medium">{x.complication}:</span> {x.clinicalEvidence}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
