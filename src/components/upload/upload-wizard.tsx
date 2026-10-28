"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, UploadCloud, XCircle } from "lucide-react";
import { api, chunkedUpload } from "@/lib/client/fetch";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Label } from "@/components/ui/label";
import { NativeSelectClass } from "@/components/common";
import { cn } from "@/lib/utils";

type Preview = {
  id: string;
  sheets: string[];
  sheetName: string | null;
  headers: string[];
  totalRows: number;
  detectedKind: string | null;
  suggestedMapping: Record<string, string | null>;
  preview: Record<string, string>[];
  duplicateOf?: { fileName: string; importedAt: string } | null;
};

type Report = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  uniquePatients: number;
  uniqueEncounters: number;
  notesByEncounter: { mrn: string; csn: string; notes: number; uniqueNotes: number }[];
  notesRequiringAttention: number;
  missingIdentifiers: number;
  blankNotes: number;
  missingRequiredColumns: string[];
  issues: { row: number; field: string; severity: "error" | "warning"; message: string }[];
  issuesTruncated: boolean;
  warnings: string[];
};

const FIELD_LABELS: Record<string, Record<string, { label: string; required: boolean }>> = {
  CLINICAL_NOTES: {
    mrn: { label: "MRN", required: true },
    csn: { label: "CSN", required: true },
    noteId: { label: "NOTE_ID", required: true },
    noteText: { label: "Clinical note text", required: true },
    dateOfService: { label: "Date of Service", required: true },
    noteType: { label: "Note type", required: false },
    filedDate: { label: "Filed date", required: false },
    flag: { label: "Flag notes", required: false },
  },
  HISTORICAL_COMPLICATIONS: {
    mrn: { label: "MRN", required: true },
    csn: { label: "CSN", required: true },
    dateOfService: { label: "Date of Service", required: true },
    complication: { label: "Complication", required: true },
    noteInfo: { label: "Note Info", required: false },
    keyWords: { label: "Key Words", required: false },
    additionalInfo: { label: "Additional info", required: false },
  },
};

const metaSchema = z.object({
  kind: z.enum(["CLINICAL_NOTES", "HISTORICAL_COMPLICATIONS"]),
  dataClassification: z.enum(["SYNTHETIC", "DEIDENTIFIED", "PHI"]),
});
type Meta = z.infer<typeof metaSchema>;

const STEPS = ["Select file", "Preview & map", "Validate", "Import"];

export function UploadWizard() {
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [report, setReport] = useState<Report | null>(null);
  const [result, setResult] = useState<
    (Report & { importedNotes: number; alreadyPresentNotes: number; importedExamples: number; derivedSurgeryDates: number }) | null
  >(null);
  const [prepJobId, setPrepJobId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const form = useForm<Meta>({ resolver: zodResolver(metaSchema), defaultValues: { kind: "CLINICAL_NOTES", dataClassification: "SYNTHETIC" } });
  const kind = form.watch("kind");

  const pick = useCallback((f: File | undefined) => {
    if (!f) return;
    if (!/\.(xlsx|csv)$/i.test(f.name)) {
      toast.error("Only .xlsx and .csv files are supported");
      return;
    }
    setFile(f);
  }, []);

  const upload = form.handleSubmit(async (meta) => {
    if (!file) return toast.error("Choose a file first");
    setBusy(true);
    try {
      const p = await chunkedUpload<Preview>(file, meta, setProgress);
      if (p.detectedKind && p.detectedKind !== meta.kind)
        toast.warning(`Headers look like ${p.detectedKind.replace("_", " ").toLowerCase()}; check the dataset type.`);
      setPreview(p);
      setMapping(p.suggestedMapping);
      setStep(1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  });

  async function changeSheet(sheetName: string) {
    if (!preview) return;
    setBusy(true);
    try {
      const p = await api<Preview>(`/api/upload/${preview.id}`, { method: "POST", json: { action: "preview", sheetName } });
      setPreview({ ...p, id: preview.id });
      setMapping(p.suggestedMapping);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await api<{ report: Report }>(`/api/upload/${preview.id}`, {
        method: "POST",
        json: { action: "validate", sheetName: preview.sheetName, mapping },
      });
      setReport(r.report);
      setStep(2);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await api<{ result: NonNullable<typeof result>; prepJobId: string | null }>(`/api/upload/${preview.id}`, {
        method: "POST",
        json: { action: "import", sheetName: preview.sheetName, mapping },
      });
      setResult(r.result);
      setPrepJobId(r.prepJobId);
      setStep(3);
      toast.success("Import complete");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep(0);
    setFile(null);
    setPreview(null);
    setReport(null);
    setResult(null);
    setProgress(0);
  }

  const fields = FIELD_LABELS[kind];
  const missing = Object.entries(fields)
    .filter(([k, d]) => d.required && !mapping[k])
    .map(([, d]) => d.label);

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap items-center gap-2" aria-label="Upload steps">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span
              aria-current={i === step ? "step" : undefined}
              className={cn(
                "flex size-7 items-center justify-center rounded-full text-xs font-semibold",
                i < step ? "bg-emerald-600 text-white" : i === step ? "bg-primary text-primary-foreground" : "bg-slate-200 text-slate-600",
              )}
            >
              {i < step ? <CheckCircle2 className="size-4" aria-hidden /> : i + 1}
            </span>
            <span className={cn("text-sm", i === step ? "font-medium" : "text-muted-foreground")}>{s}</span>
            {i < STEPS.length - 1 && <span aria-hidden className="mx-1 h-px w-8 bg-slate-300" />}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Select a dataset</CardTitle>
            <CardDescription>
              CSV or Excel. Identifiers are kept as text, so leading zeros are preserved. Uploaded files are stored in the application database, never in Git.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div
              role="button"
              tabIndex={0}
              aria-label="Drop a file here or press Enter to browse"
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pick(e.dataTransfer.files[0]);
              }}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 text-center transition-colors",
                dragging ? "border-primary bg-primary/5" : "border-slate-300 bg-slate-50 hover:border-primary/60",
              )}
            >
              <UploadCloud className="mb-2 size-8 text-primary" aria-hidden />
              {file ? (
                <p className="flex items-center gap-2 font-medium">
                  <FileSpreadsheet className="size-4" aria-hidden /> {file.name}{" "}
                  <span className="text-muted-foreground">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                </p>
              ) : (
                <>
                  <p className="font-medium">Drag and drop a file, or click to browse</p>
                  <p className="text-sm text-muted-foreground">.xlsx or .csv</p>
                </>
              )}
              <input ref={inputRef} type="file" accept=".xlsx,.csv" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="kind">Dataset type</Label>
                <select id="kind" className={cn(NativeSelectClass, "w-full")} {...form.register("kind")}>
                  <option value="CLINICAL_NOTES">Clinical notes (e.g. SampleNotes.xlsx)</option>
                  <option value="HISTORICAL_COMPLICATIONS">Historical expected complications (e.g. Complications.xlsx)</option>
                </select>
              </div>
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium">Data classification</legend>
                <div className="flex flex-wrap gap-3 text-sm">
                  {(["SYNTHETIC", "DEIDENTIFIED", "PHI"] as const).map((c) => (
                    <label key={c} className="flex items-center gap-1.5">
                      <input type="radio" value={c} {...form.register("dataClassification")} />{" "}
                      {c === "PHI" ? "Contains PHI" : c === "DEIDENTIFIED" ? "De-identified" : "Synthetic"}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Non-synthetic data cannot be sent to OpenAI unless PHI processing has been approved.</p>
              </fieldset>
            </div>
            {busy && <Progress value={progress} aria-label="Upload progress" />}
            <Button onClick={upload} disabled={!file || busy}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <UploadCloud aria-hidden />} Upload and preview
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 1 && preview && (
        <Card>
          <CardHeader>
            <CardTitle>Preview and column mapping</CardTitle>
            <CardDescription>
              {preview.totalRows.toLocaleString()} rows detected. Long text is truncated in this preview.
              {preview.duplicateOf && (
                <span className="ml-1 font-medium text-amber-700">An identical file ({preview.duplicateOf.fileName}) was already imported.</span>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {preview.sheets.length > 1 && (
              <div className="space-y-1.5">
                <Label htmlFor="sheet">Worksheet</Label>
                <select id="sheet" className={NativeSelectClass} value={preview.sheetName ?? ""} onChange={(e) => changeSheet(e.target.value)} disabled={busy}>
                  {preview.sheets.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Object.entries(fields).map(([key, def]) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`map-${key}`}>
                    {def.label} {def.required && <span className="text-destructive">*</span>}
                  </Label>
                  <select
                    id={`map-${key}`}
                    className={cn(NativeSelectClass, "w-full", def.required && !mapping[key] && "border-destructive")}
                    value={mapping[key] ?? ""}
                    onChange={(e) => setMapping({ ...mapping, [key]: e.target.value || null })}
                  >
                    <option value="">— not mapped —</option>
                    {preview.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div className="max-h-80 overflow-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-100">
                  <tr>
                    {preview.headers.map((h) => (
                      <th key={h} scope="col" className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.preview.map((r, i) => (
                    <tr key={i} className="border-t">
                      {preview.headers.map((h) => (
                        <td key={h} className="max-w-64 truncate px-2 py-1 align-top" title={r[h]}>
                          {r[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={reset}>
                Start over
              </Button>
              <Button onClick={validate} disabled={busy || missing.length > 0}>
                {busy && <Loader2 className="animate-spin" aria-hidden />} Validate {missing.length > 0 && `(map: ${missing.join(", ")})`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && report && (
        <Card>
          <CardHeader>
            <CardTitle>Import report</CardTitle>
            <CardDescription>Review data-quality findings. Invalid and duplicate rows are kept and reported, never silently dropped.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <ReportGrid report={report} />
            {report.warnings.map((w) => (
              <p key={w} className="flex items-center gap-2 text-sm text-amber-800">
                <AlertTriangle className="size-4" aria-hidden /> {w}
              </p>
            ))}
            {report.notesByEncounter.length > 0 && (
              <details className="rounded-lg border bg-white p-3">
                <summary className="cursor-pointer text-sm font-medium">Notes by encounter ({report.notesByEncounter.length})</summary>
                <table className="mt-2 w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1">MRN</th>
                      <th>CSN</th>
                      <th>Rows</th>
                      <th>Unique notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.notesByEncounter.map((e) => (
                      <tr key={`${e.mrn}|${e.csn}`} className="border-t">
                        <td className="py-1 font-mono">{e.mrn}</td>
                        <td className="font-mono">{e.csn}</td>
                        <td>{e.notes}</td>
                        <td>{e.uniqueNotes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
            <IssueTable issues={report.issues} truncated={report.issuesTruncated} />
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep(1)}>
                Back to mapping
              </Button>
              <Button onClick={doImport} disabled={busy || report.validRows === 0 || report.missingRequiredColumns.length > 0}>
                {busy && <Loader2 className="animate-spin" aria-hidden />} Import {report.validRows.toLocaleString()} valid rows
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 3 && result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-emerald-600" aria-hidden /> Import complete
            </CardTitle>
            <CardDescription>
              {kind === "CLINICAL_NOTES"
                ? `${result.importedNotes} new unique notes imported (${result.alreadyPresentNotes} already present). Provisional surgery dates derived from operative notes for ${result.derivedSurgeryDates} encounter(s) — confirm them in the review screen.`
                : `${result.importedExamples} historical labels imported with original values preserved. Evidence mapping runs in the background.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Link href="/processing" className={buttonVariants()}>
              Go to AI processing
            </Link>
            {prepJobId && (
              <Link href="/validation" className={buttonVariants({ variant: "outline" })}>
                Historical validation
              </Link>
            )}
            <Link href="/patients" className={buttonVariants({ variant: "outline" })}>
              Search patients
            </Link>
            <Button variant="ghost" onClick={reset}>
              Upload another file
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ReportGrid({ report }: { report: Report }) {
  const items = [
    ["Total rows", report.totalRows],
    ["Valid rows", report.validRows],
    ["Invalid rows", report.invalidRows],
    ["Duplicate rows", report.duplicateRows],
    ["Unique patients", report.uniquePatients],
    ["Unique encounters", report.uniqueEncounters],
    ["Needing attention", report.notesRequiringAttention],
    ["Missing identifiers", report.missingIdentifiers],
    ["Blank notes", report.blankNotes],
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {items.map(([k, v]) => (
        <div key={k} className="rounded-lg border bg-slate-50 p-3">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="text-xl font-semibold tabular-nums">{v.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function IssueTable({ issues, truncated }: { issues: Report["issues"]; truncated: boolean }) {
  if (!issues.length)
    return (
      <p className="flex items-center gap-2 text-sm text-emerald-700">
        <CheckCircle2 className="size-4" aria-hidden /> No data-quality issues found.
      </p>
    );
  return (
    <div className="max-h-72 overflow-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-slate-100 text-left">
          <tr>
            <th className="px-2 py-1.5">Row</th>
            <th>Field</th>
            <th>Severity</th>
            <th>Issue</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i, idx) => (
            <tr key={idx} className="border-t">
              <td className="px-2 py-1 tabular-nums">{i.row}</td>
              <td>{i.field}</td>
              <td>
                {i.severity === "error" ? (
                  <span className="inline-flex items-center gap-1 text-rose-700">
                    <XCircle className="size-3.5" aria-hidden /> Error
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-amber-700">
                    <AlertTriangle className="size-3.5" aria-hidden /> Warning
                  </span>
                )}
              </td>
              <td>{i.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <p className="p-2 text-xs text-muted-foreground">Showing first 500 issues.</p>}
    </div>
  );
}
