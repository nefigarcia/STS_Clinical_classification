"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, FlaskConical, Loader2, Microscope, Play } from "lucide-react";
import { api } from "@/lib/client/fetch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelectClass, StatusBadge, formatDate, formatUsd } from "@/components/common";

type Metrics = {
  encounters: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  exactMatchAccuracy: number | null;
  evidenceCitationAccuracy: number | null;
  perLabel: { label: string; tp: number; fp: number; fn: number; sensitivity: number | null }[];
  costUsd?: number | null;
};
type Row = { encounterId: string; mrn: string; csn: string; date: string | null; expected: string | null; predicted: string | null; result: string };
type Example = {
  id: string;
  source: string;
  mrn: string;
  csn: string;
  dateOfService: string | null;
  originalLabel: string;
  complication: string;
  noteInfo: string | null;
  keyWords: string | null;
  additionalInfo: string | null;
  quality: string;
  qualityReason: string | null;
  libraryStatus: string;
  cohort: string;
  supportingNoteIds: string[];
  candidateNoteIds: string[];
  clinicalEvidence: string | null;
  encounterId: string | null;
  stsRule: { pageNumber: number; sectionName: string | null; manualVersion: string } | null;
};
type Run = {
  id: string;
  name: string;
  model: string;
  cohort: string;
  status: string;
  metrics: Metrics | null;
  createdAt: string;
  promptVersion: string | null;
  libraryVersion: number | null;
};
type Data = { comparison: { metrics: Metrics; rows: Row[]; patients: number; examples: number }; examples: Example[]; runs: Run[] };

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);

export function ValidationDashboard({ canReview, isAdmin }: { canReview: boolean; isAdmin: boolean }) {
  const [cohort, setCohort] = useState("");
  const [busy, setBusy] = useState(false);
  const [holdout, setHoldout] = useState<string[]>([]);
  const { data, error, reload } = useApi<Data>(`/api/validation${cohort ? `?cohort=${cohort}` : ""}`);

  async function post(body: unknown, msg: string) {
    setBusy(true);
    try {
      await api("/api/validation", { method: "POST", json: body });
      toast.success(msg);
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>;
  if (!data)
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
      </p>
    );
  const m = data.comparison.metrics;
  const patients = [...new Set(data.examples.filter((e) => e.source === "HISTORICAL_IMPORT").map((e) => e.mrn))];

  return (
    <div className="space-y-6">
      <div role="note" className="flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div>
          <p className="font-semibold">Development diagnostics only, not validated clinical performance</p>
          <p>
            The historical reference set has {data.comparison.examples} labels from {data.comparison.patients} patient(s), which is far too few to establish
            accuracy. Cohorts are assigned per patient to prevent leakage, held-out labels are never retrieved as examples, and evaluating on DEVELOPMENT labels
            is optimistic. Clinical validation needs an independent, clinically reviewed test cohort.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="cohort" className="text-sm font-medium">
          Cohort
        </label>
        <select id="cohort" className={NativeSelectClass} value={cohort} onChange={(e) => setCohort(e.target.value)}>
          <option value="">All historical labels</option>
          <option value="DEVELOPMENT">Development</option>
          <option value="HOLDOUT">Held-out</option>
          <option value="INDEPENDENT_TEST">Independent test</option>
        </select>
        {canReview && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => post({ action: "map_evidence" }, "Evidence mapping queued")}>
            <Microscope aria-hidden /> Re-map historical evidence
          </Button>
        )}
      </div>

      <section aria-label="Metrics" className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {[
          ["Precision", pct(m.precision)],
          ["Recall", pct(m.recall)],
          ["F1", pct(m.f1)],
          ["False-positive rate", pct(m.falsePositiveRate)],
          ["False-negative rate", pct(m.falseNegativeRate)],
          ["Exact-match accuracy", pct(m.exactMatchAccuracy)],
          ["Evidence citation accuracy", pct(m.evidenceCitationAccuracy)],
          ["Encounters evaluated", m.encounters],
        ].map(([k, v]) => (
          <div key={String(k)} className="rounded-xl border bg-white p-3">
            <div className="text-xs text-muted-foreground">{k}</div>
            <div className="text-xl font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Expected vs AI prediction</CardTitle>
            <CardDescription>
              Labels are compared after the administrator label map (Settings). TP {m.tp} · FP {m.fp} · FN {m.fn}
            </CardDescription>
          </CardHeader>
          <CardContent className="max-h-[480px] overflow-auto p-0">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left">
                <tr>
                  {["MRN", "CSN", "Date", "Expected", "AI Prediction", "Result"].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.comparison.rows.map((r, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-3 py-1.5 font-mono">{r.mrn}</td>
                    <td className="font-mono">{r.csn}</td>
                    <td className="tabular-nums">{r.date ?? "—"}</td>
                    <td>{r.expected ?? "—"}</td>
                    <td>{r.predicted ?? "—"}</td>
                    <td>
                      {r.encounterId && !r.encounterId.startsWith("unmatched") ? (
                        <Link href={`/patients/${r.encounterId}`}>
                          <StatusBadge status={r.result} />
                        </Link>
                      ) : (
                        <StatusBadge status={r.result} />
                      )}
                    </td>
                  </tr>
                ))}
                {data.comparison.rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-muted-foreground">
                      Import Complications.xlsx to compare.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Sensitivity by complication</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left">
                <tr>
                  <th className="px-3 py-2">Label</th>
                  <th>TP</th>
                  <th>FP</th>
                  <th>FN</th>
                  <th>Sens.</th>
                </tr>
              </thead>
              <tbody>
                {m.perLabel.map((l) => (
                  <tr key={l.label} className="border-t tabular-nums">
                    <td className="px-3 py-1.5">{l.label}</td>
                    <td>{l.tp}</td>
                    <td>{l.fp}</td>
                    <td>{l.fn}</td>
                    <td>{pct(l.sensitivity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Historical example verification</CardTitle>
          <CardDescription>
            The MRN + CSN + Date of Service join finds candidate notes only. A clinician must check the evidence before an example becomes VERIFIED and can be
            used as a few-shot example. Original labels are kept unchanged.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.examples.map((e) => (
            <div key={e.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{e.originalLabel}</span>
                <StatusBadge status={e.quality} />
                <StatusBadge status={e.libraryStatus} />
                <span className="rounded bg-slate-100 px-1.5 text-xs">{e.cohort.toLowerCase()}</span>
                <span className="rounded bg-slate-100 px-1.5 text-xs">{e.source === "REVIEWER_FEEDBACK" ? "reviewer feedback" : "historical import"}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  MRN {e.mrn} · CSN {e.csn} · {formatDate(e.dateOfService)}
                </span>
              </div>
              {(e.keyWords || e.noteInfo || e.additionalInfo) && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {e.keyWords && <>Key words: {e.keyWords}. </>}
                  {e.noteInfo && <>Note info: {e.noteInfo}. </>}
                  {e.additionalInfo && <>Additional: {e.additionalInfo}</>}
                </p>
              )}
              {e.qualityReason && <p className="mt-1 text-xs">{e.qualityReason}</p>}
              {e.clinicalEvidence && (
                <pre className="mt-2 max-h-32 overflow-auto rounded bg-amber-50/60 p-2 text-xs whitespace-pre-wrap">{e.clinicalEvidence}</pre>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">
                  Supporting NOTE_IDs: {e.supportingNoteIds.join(", ") || "none"} · candidates: {e.candidateNoteIds.length}
                </span>
                {e.stsRule ? (
                  <span>
                    STS ref: TM {e.stsRule.manualVersion} p.{e.stsRule.pageNumber}
                  </span>
                ) : (
                  <span className="text-amber-700">No STS rule linked</span>
                )}
                {e.encounterId && (
                  <Link href={`/patients/${e.encounterId}`} className="text-primary underline">
                    Open encounter
                  </Link>
                )}
                {canReview && (
                  <span className="ml-auto flex gap-1">
                    <Button
                      size="xs"
                      disabled={busy || !e.clinicalEvidence}
                      onClick={() => post({ action: "review_example", id: e.id, decision: "approve" }, "Example verified")}
                    >
                      Verify
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => post({ action: "review_example", id: e.id, decision: "conflicting" }, "Marked conflicting")}
                    >
                      Conflicting
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => post({ action: "review_example", id: e.id, decision: "insufficient" }, "Marked insufficient")}
                    >
                      Insufficient
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => post({ action: "review_example", id: e.id, decision: "reject" }, "Excluded from library")}
                    >
                      Exclude
                    </Button>
                  </span>
                )}
              </div>
            </div>
          ))}
          {data.examples.length === 0 && <p className="text-sm text-muted-foreground">No historical examples yet.</p>}
        </CardContent>
      </Card>

      {isAdmin && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Patient-level cohorts</CardTitle>
              <CardDescription>
                Choose patients to hold out. All of a patient&apos;s labels move together, so notes from one patient are never split.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {patients.map((mrn) => (
                <label key={mrn} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={holdout.includes(mrn)}
                    onChange={(e) => setHoldout(e.target.checked ? [...holdout, mrn] : holdout.filter((x) => x !== mrn))}
                  />
                  <span className="font-mono">{mrn}</span> — hold out
                </label>
              ))}
              <Button size="sm" disabled={busy} onClick={() => post({ action: "assign_cohorts", holdoutMrns: holdout }, "Cohorts assigned")}>
                Save cohorts
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="size-4" aria-hidden /> Model comparison
              </CardTitle>
              <CardDescription>Run the primary and escalation models on the same labelled cohort. Results are not saved as predictions.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {(["HOLDOUT", "INDEPENDENT_TEST", "DEVELOPMENT"] as const).map((c) =>
                (["primary", "escalation"] as const).map((model) => (
                  <Button
                    key={c + model}
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => post({ action: "run_evaluation", model, cohort: c }, `Evaluation queued (${model} on ${c})`)}
                  >
                    <Play aria-hidden /> {model} · {c.toLowerCase()}
                  </Button>
                )),
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Evaluation runs</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left">
              <tr>
                {["Run", "Model", "Cohort", "Status", "Precision", "Recall", "F1", "Exact match", "Cost", "Created"].map((h) => (
                  <th key={h} className="px-3 py-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id} className="border-t tabular-nums">
                  <td className="px-3 py-1.5">{r.name}</td>
                  <td className="font-mono">{r.model}</td>
                  <td>{r.cohort.toLowerCase()}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td>{pct(r.metrics?.precision)}</td>
                  <td>{pct(r.metrics?.recall)}</td>
                  <td>{pct(r.metrics?.f1)}</td>
                  <td>{pct(r.metrics?.exactMatchAccuracy)}</td>
                  <td>{r.metrics ? formatUsd(r.metrics.costUsd ?? null) : "—"}</td>
                  <td>{formatDate(r.createdAt, true)}</td>
                </tr>
              ))}
              {data.runs.length === 0 && (
                <tr>
                  <td colSpan={10} className="p-4 text-center text-muted-foreground">
                    No evaluation runs.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
