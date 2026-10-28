"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { BookOpen, CheckCircle2, FileUp, Loader2, Search, ShieldAlert } from "lucide-react";
import { api, chunkedUpload } from "@/lib/client/fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, NativeSelectClass, StatusBadge, formatDate } from "@/components/common";

type Manual = {
  id: string;
  version: string;
  title: string | null;
  fileName: string;
  pageCount: number | null;
  detectedVersion: string | null;
  identityCheck: { isStsChsdManual: boolean; reason: string; signals: Record<string, boolean> } | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isDefault: boolean;
  status: string;
  embeddingModel: string | null;
  approvedAt: string | null;
  approvedBy: { email: string } | null;
  stats: { total: number; complication: number; coded: number; embedded: number; withDefinition: number };
};
type Rule = {
  id: string;
  sectionName: string | null;
  pageNumber: number;
  longName: string | null;
  shortName: string | null;
  stsCode: string | null;
  complicationName: string | null;
  chunkText: string;
};
type FullRule = Rule & {
  manualVersion: string;
  definition: string | null;
  intentClarification: string | null;
  codingInstructions: string | null;
  inclusionExclusion: string | null;
  specialNotes: string | null;
  seqNumber: string | null;
  dbTable: string | null;
  validCodes: { code: string; value: string }[] | null;
  pageEnd: number | null;
};

export function KnowledgeBase({ isAdmin }: { isAdmin: boolean }) {
  const sp = useSearchParams();
  const [selectedManual, setSelectedManual] = useState<string>("");
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [pickedRule, setPickedRule] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);

  const { data: manualData, reload: load } = useApi<{ manuals: Manual[] }>("/api/knowledge-base/manuals", { pollMs: 10_000 });
  const manuals = manualData?.manuals ?? [];
  const manualId = selectedManual || manuals.find((m) => m.status === "APPROVED")?.id || manuals.find((m) => m.stats.total > 0)?.id || "";
  const { data: ruleData } = useApi<{ rules: Rule[] }>(
    manualId ? `/api/knowledge-base/search?manualVersionId=${manualId}&q=${encodeURIComponent(submittedQ)}` : null,
  );
  const rules = ruleData?.rules ?? [];
  const ruleId = pickedRule ?? sp.get("rule");
  const { data: ruleDetail } = useApi<{ rule: FullRule }>(ruleId ? `/api/knowledge-base/search?ruleId=${ruleId}` : null);
  const rule = ruleDetail?.rule ?? null;
  const search = () => setSubmittedQ(q);
  const setManualId = setSelectedManual;

  async function uploadManual() {
    if (!file || !version.trim()) return toast.error("Choose the manual PDF and enter its version label");
    setBusy(true);
    try {
      const up = await chunkedUpload<{ id: string }>(file, { kind: "STS_MANUAL", dataClassification: "DEIDENTIFIED" }, setProgress);
      await api("/api/knowledge-base/manuals", {
        method: "POST",
        json: { sourceFileId: up.id, version: version.trim(), effectiveFrom: from || null, effectiveTo: to || null },
      });
      toast.success("Manual uploaded. Identity check and indexing are running in the background.");
      setFile(null);
      setVersion("");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(0);
    }
  }

  async function act(id: string, action: string, extra: Record<string, unknown> = {}) {
    if (
      action === "approve" &&
      !window.confirm(
        "Confirm this document is the official STS CHSD Training Manual for the stated version, and that the extracted rules have been spot-checked.",
      )
    )
      return;
    try {
      await api(`/api/knowledge-base/manuals/${id}`, {
        method: "PATCH",
        json: { action, ...extra, ...(action === "approve" ? { confirmIdentity: true } : {}) },
      });
      toast.success(`Manual ${action.replace("_", " ")}`);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      {!manuals.some((m) => m.status === "APPROVED") && (
        <div role="alert" className="flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>
            <strong>STS-based classification is unavailable.</strong> No approved STS CHSD Training Manual is loaded. The expected file is{" "}
            <em>2026-07_CHSD TM Version 6.23.2.pdf</em>. Unrelated documents (for example vendor order forms) fail the identity check and cannot be indexed.
          </p>
        </div>
      )}

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Load an STS manual version</CardTitle>
            <CardDescription>
              The PDF is processed once per version: text extraction, identity check, semantic chunking by field and section, then embedding (manual text only).
              It is never re-sent for each patient.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-5">
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="pdf">Manual PDF</Label>
              <Input id="pdf" type="file" accept=".pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ver">Version label</Label>
              <Input id="ver" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="6.23.2" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="from">Effective from (surgery date)</Label>
              <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="to">Effective to (exclusive)</Label>
              <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="md:col-span-5">
              {busy && <Progress value={progress} className="mb-2" aria-label="Upload progress" />}
              <Button onClick={uploadManual} disabled={busy || !file}>
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : <FileUp aria-hidden />} Upload and index
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <section aria-label="Manual versions" className="grid gap-3 lg:grid-cols-2">
        {manuals.map((m) => (
          <Card key={m.id}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                STS CHSD TM {m.version} <StatusBadge status={m.status} />{" "}
                {m.isDefault && <span className="rounded bg-primary/10 px-1.5 text-xs text-primary">default</span>}
              </CardTitle>
              <CardDescription>
                {m.fileName} · {m.pageCount ?? "?"} pages {m.detectedVersion && `· version detected in PDF: ${m.detectedVersion}`}
                {m.detectedVersion && m.detectedVersion !== m.version && <span className="ml-1 font-medium text-amber-700">(label mismatch)</span>}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {m.identityCheck && (
                <p className={m.identityCheck.isStsChsdManual ? "text-emerald-700" : "text-rose-700"}>
                  {m.identityCheck.isStsChsdManual ? (
                    <CheckCircle2 className="mr-1 inline size-4" aria-hidden />
                  ) : (
                    <ShieldAlert className="mr-1 inline size-4" aria-hidden />
                  )}
                  {m.identityCheck.reason}
                </p>
              )}
              <dl className="grid grid-cols-5 gap-2 text-center text-xs">
                {[
                  ["Rules", m.stats.total],
                  ["Complication", m.stats.complication],
                  ["Coded", m.stats.coded],
                  ["Definitions", m.stats.withDefinition],
                  ["Embedded", m.stats.embedded],
                ].map(([k, v]) => (
                  <div key={String(k)} className="rounded border bg-slate-50 p-1.5">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="font-semibold tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-muted-foreground">
                Effective {formatDate(m.effectiveFrom)} → {formatDate(m.effectiveTo)} · embeddings: {m.embeddingModel ?? "none (keyword search)"}
                {m.approvedAt && ` · approved ${formatDate(m.approvedAt)} by ${m.approvedBy?.email}`}
              </p>
              {isAdmin && (
                <div className="flex flex-wrap gap-2">
                  {m.status === "INDEXED" && (
                    <Button size="sm" onClick={() => act(m.id, "approve")}>
                      Approve for classification
                    </Button>
                  )}
                  {m.status === "APPROVED" && !m.isDefault && (
                    <Button size="sm" variant="outline" onClick={() => act(m.id, "set_default")}>
                      Set default
                    </Button>
                  )}
                  {m.status === "APPROVED" && (
                    <Button size="sm" variant="ghost" onClick={() => act(m.id, "retire")}>
                      Retire
                    </Button>
                  )}
                  {["FAILED", "RETIRED", "INDEXED", "REJECTED"].includes(m.status) && (
                    <Button size="sm" variant="ghost" onClick={() => act(m.id, "reindex")}>
                      Re-index
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Rule browser</CardTitle>
          <CardDescription>Search the indexed manual. These are the only rule texts the AI is allowed to cite.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {manuals.some((m) => m.stats.total > 0) ? (
            <>
              <div className="flex flex-wrap gap-2">
                <select aria-label="Manual version" className={NativeSelectClass} value={manualId} onChange={(e) => setManualId(e.target.value)}>
                  {manuals
                    .filter((m) => m.stats.total > 0)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        TM {m.version} ({m.status.toLowerCase()})
                      </option>
                    ))}
                </select>
                <Input
                  className="max-w-md"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && search()}
                  placeholder="e.g. unplanned reoperation, chylothorax"
                  aria-label="Search rules"
                />
                <Button variant="outline" onClick={search}>
                  <Search aria-hidden /> Search
                </Button>
              </div>
              <ul className="divide-y rounded-lg border">
                {rules.map((r) => (
                  <li key={r.id}>
                    <button className="w-full p-3 text-left text-sm hover:bg-slate-50" onClick={() => setPickedRule(r.id)}>
                      <span className="font-medium">{r.complicationName ?? r.longName ?? r.sectionName ?? "Section text"}</span>
                      {r.stsCode && <span className="ml-2 font-mono text-xs">code {r.stsCode}</span>}
                      <span className="ml-2 text-xs text-muted-foreground">
                        p.{r.pageNumber} · {r.sectionName}
                      </span>
                      <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{r.chunkText}</span>
                    </button>
                  </li>
                ))}
                {rules.length === 0 && <li className="p-3 text-sm text-muted-foreground">No rules found.</li>}
              </ul>
            </>
          ) : (
            <EmptyState icon={BookOpen} title="No manual indexed">
              Upload the official STS CHSD Training Manual to enable rule search.
            </EmptyState>
          )}
        </CardContent>
      </Card>

      {rule && (
        <Card id="rule-detail" className="border-primary/40">
          <CardHeader>
            <CardTitle>{rule.complicationName ?? rule.longName ?? rule.sectionName}</CardTitle>
            <CardDescription>
              STS CHSD TM {rule.manualVersion} · {rule.sectionName} · page {rule.pageNumber}
              {rule.pageEnd && rule.pageEnd !== rule.pageNumber ? `–${rule.pageEnd}` : ""}
              {rule.shortName && ` · ${rule.shortName}`} {rule.seqNumber && ` · Seq #${rule.seqNumber}`} {rule.stsCode && ` · code ${rule.stsCode}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {(
              [
                ["Definition", rule.definition],
                ["Intent / Clarification", rule.intentClarification],
                ["Coding instructions", rule.codingInstructions],
                ["Inclusion / exclusion", rule.inclusionExclusion],
                ["Notes", rule.specialNotes],
              ] as const
            ).map(([k, v]) =>
              v ? (
                <div key={k}>
                  <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{k}</h4>
                  <p className="whitespace-pre-wrap">{v}</p>
                </div>
              ) : null,
            )}
            {rule.validCodes && rule.validCodes.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Valid codes</h4>
                <ul className="text-xs">
                  {rule.validCodes.map((c) => (
                    <li key={c.code}>
                      <span className="font-mono">{c.code}</span> — {c.value}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">Full extracted text</summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap">{rule.chunkText}</pre>
            </details>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
