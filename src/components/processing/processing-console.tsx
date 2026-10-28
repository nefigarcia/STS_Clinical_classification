"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { toast } from "sonner";
import { Cpu, Loader2, Pause, Play, RotateCcw, Square, Zap } from "lucide-react";
import { api } from "@/lib/client/fetch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { EmptyState, NativeSelectClass, StatusBadge, formatDate, formatUsd } from "@/components/common";

type Job = {
  id: string;
  type: string;
  fileName: string | null;
  processingStatus: string;
  totalRecords: number;
  processedRecords: number;
  failedRecords: number;
  currentModel: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  tokenUsage: number;
  actualCost: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastTickAt: string | null;
  errors: { at: string; ref: string | null; message: string }[] | null;
};
type Detail = {
  job: Job;
  items: Record<string, number>;
  byModel: {
    model: string;
    _count: number;
    _sum: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; costUsd: number | null };
  }[];
  escalated: number;
  cacheHits: number;
};

const ACTIVE = ["QUEUED", "RUNNING"];

export function ProcessingConsole({ canRun, gateReasons }: { canRun: boolean; gateReasons: string[] }) {
  const [picked, setSelected] = useState<string | null>(null);
  const [scope, setScope] = useState("all_unprocessed");
  const [busy, setBusy] = useState(false);
  const [pollMs, setPollMs] = useState(15_000);
  const { data: jobData, reload: reloadJobs } = useApi<{ jobs: Job[] }>("/api/jobs", { pollMs });
  const jobs = jobData?.jobs ?? [];
  const selected = picked ?? jobs[0]?.id ?? null;
  const { data: detail, reload: reloadDetail, loadedAt } = useApi<Detail>(selected ? `/api/jobs/${selected}` : null, { pollMs });
  const anyActive = jobs.some((j) => ACTIVE.includes(j.processingStatus));
  if ((anyActive ? 3000 : 15_000) !== pollMs) setPollMs(anyActive ? 3000 : 15_000);
  const load = () => {
    reloadJobs();
    reloadDetail();
  };

  async function start() {
    setBusy(true);
    try {
      const r = await api<{ jobId: string; encounters: number }>("/api/jobs", { method: "POST", json: { scope } });
      toast.success(`Classification queued for ${r.encounters} encounter(s)`);
      setSelected(r.jobId);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(action: string) {
    if (!detail) return;
    try {
      await api(`/api/jobs/${detail.job.id}`, { method: "PATCH", json: { action } });
      toast.success(`Job ${action.replace("_", " ")}`);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const j = detail?.job;
  const pct = j && j.totalRecords ? Math.round(((j.processedRecords + j.failedRecords) / j.totalRecords) * 100) : 0;
  const pending = detail ? (detail.items.PENDING ?? 0) + (detail.items.RUNNING ?? 0) : 0;

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="space-y-4 xl:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>Start classification</CardTitle>
            <CardDescription>
              Runs in the background on the server; you can close this tab. Each encounter is analyzed with retrieved STS rules and verified examples, then
              validated before saving.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!canRun && (
              <ul className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                {gateReasons.map((r) => (
                  <li key={r}>• {r}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="scope" className="text-sm font-medium">
                Encounters
              </label>
              <select id="scope" className={NativeSelectClass} value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="all_unprocessed">Not yet processed</option>
                <option value="all">All encounters (re-run; cached results reused)</option>
              </select>
              <Button onClick={start} disabled={busy || !canRun}>
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Zap aria-hidden />} Start AI classification
              </Button>
            </div>
          </CardContent>
        </Card>

        {!j ? (
          <EmptyState icon={Cpu} title="No processing jobs yet" />
        ) : (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  {j.type
                    .replace("_", " ")
                    .toLowerCase()
                    .replace(/^\w/, (c) => c.toUpperCase())}{" "}
                  job <StatusBadge status={j.processingStatus} />
                </CardTitle>
                <CardDescription className="font-mono text-xs">
                  {j.id} · created {formatDate(j.createdAt, true)} {j.lastTickAt && `· last activity ${formatDate(j.lastTickAt, true)}`}
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                {ACTIVE.includes(j.processingStatus) && (
                  <Button size="sm" variant="outline" onClick={() => act("pause")}>
                    <Pause aria-hidden /> Pause
                  </Button>
                )}
                {["PAUSED", "FAILED"].includes(j.processingStatus) ||
                (j.processingStatus === "RUNNING" && j.lastTickAt && loadedAt - new Date(j.lastTickAt).getTime() > 6 * 60_000) ? (
                  <Button size="sm" onClick={() => act("resume")}>
                    <Play aria-hidden /> Resume
                  </Button>
                ) : null}
                {j.failedRecords > 0 && !ACTIVE.includes(j.processingStatus) && (
                  <Button size="sm" variant="outline" onClick={() => act("retry_failed")}>
                    <RotateCcw aria-hidden /> Retry failed
                  </Button>
                )}
                {!["COMPLETED", "COMPLETED_WITH_ERRORS", "CANCELLED"].includes(j.processingStatus) && (
                  <Button size="sm" variant="ghost" onClick={() => act("cancel")}>
                    <Square aria-hidden /> Cancel
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <div className="mb-1 flex justify-between text-sm">
                  <span>
                    {j.processedRecords + j.failedRecords} / {j.totalRecords} records
                  </span>
                  <span className="tabular-nums">{pct}%</span>
                </div>
                <Progress value={pct} aria-label="Job progress" />
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                {[
                  ["Total records", j.totalRecords],
                  ["Completed", j.processedRecords],
                  ["Pending", pending],
                  ["Errors", j.failedRecords],
                  ["Model in use", j.currentModel ?? "—"],
                  ["Tokens (in / out)", `${j.inputTokens.toLocaleString()} / ${j.outputTokens.toLocaleString()}`],
                  ["Cached input tokens", j.cachedTokens.toLocaleString()],
                  ["Cost", formatUsd(j.actualCost)],
                  ["Escalated", detail!.escalated],
                  ["Cache hits", detail!.cacheHits],
                ].map(([k, v]) => (
                  <div key={String(k)} className="rounded-lg border bg-slate-50 p-2.5">
                    <dt className="text-xs text-muted-foreground">{k}</dt>
                    <dd className="truncate font-medium tabular-nums" title={String(v)}>
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
              {detail!.byModel.length > 0 && (
                <table className="w-full text-sm">
                  <caption className="mb-1 text-left text-xs font-medium text-muted-foreground">Usage by model</caption>
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1">Model</th>
                      <th>Calls</th>
                      <th>Input</th>
                      <th>Cached</th>
                      <th>Output</th>
                      <th>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail!.byModel.map((m) => (
                      <tr key={m.model} className="border-t tabular-nums">
                        <td className="py-1 font-mono">{m.model}</td>
                        <td>{m._count}</td>
                        <td>{(m._sum.inputTokens ?? 0).toLocaleString()}</td>
                        <td>{(m._sum.cachedInputTokens ?? 0).toLocaleString()}</td>
                        <td>{(m._sum.outputTokens ?? 0).toLocaleString()}</td>
                        <td>{formatUsd(m._sum.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {j.errors && j.errors.length > 0 && (
                <details className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm">
                  <summary className="cursor-pointer font-medium text-rose-800">Errors ({j.errors.length})</summary>
                  <ul className="mt-2 max-h-48 space-y-1 overflow-auto font-mono text-xs">
                    {j.errors.map((e, i) => (
                      <li key={i}>
                        {formatDate(e.at, true)} — {e.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Recent jobs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 p-2">
          {jobs.map((x) => (
            <button
              key={x.id}
              onClick={() => setSelected(x.id)}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-slate-100 ${x.id === selected ? "bg-slate-100" : ""}`}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{x.type.replace("_", " ").toLowerCase()}</span>
                <span className="block text-xs text-muted-foreground">
                  {formatDate(x.createdAt, true)} · {x.processedRecords}/{x.totalRecords}
                </span>
              </span>
              <StatusBadge status={x.processingStatus} />
            </button>
          ))}
          {jobs.length === 0 && <p className="p-2 text-sm text-muted-foreground">None</p>}
        </CardContent>
      </Card>
    </div>
  );
}
