import { Activity, Coins, Database, Repeat, TriangleAlert, Zap } from "lucide-react";
import { requirePageRole } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { getSetting } from "@/lib/settings";
import { PageHeader, StatCard, StatusBadge, formatDate, formatUsd } from "@/components/common";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DailyLine } from "@/components/charts/charts";

export const dynamic = "force-dynamic";

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");

export default async function PerformancePage() {
  await requirePageRole("READ_ONLY");
  const [byModel, byPurpose, items, escalated, cacheHits, costByDay, runs, pricing, verification] = await Promise.all([
    prisma.aiCall.groupBy({
      by: ["model"],
      _count: true,
      _sum: { inputTokens: true, cachedInputTokens: true, outputTokens: true, reasoningTokens: true, costUsd: true, retries: true },
      _avg: { durationMs: true },
    }),
    prisma.aiCall.groupBy({ by: ["purpose", "success"], _count: true }),
    prisma.jobItem.count({ where: { status: "DONE", job: { type: "CLASSIFICATION" } } }),
    prisma.jobItem.count({ where: { escalated: true, job: { type: "CLASSIFICATION" } } }),
    prisma.jobItem.count({ where: { cacheHit: true, job: { type: "CLASSIFICATION" } } }),
    prisma.$queryRaw<{ day: string; cost: number | null }[]>`
      SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day, coalesce(sum("costUsd"), 0)::float AS cost
      FROM "AiCall" WHERE "createdAt" > now() - interval '30 days' GROUP BY 1 ORDER BY 1`,
    prisma.evaluationRun.findMany({ orderBy: { createdAt: "desc" }, take: 20, omit: { results: true } }),
    getSetting("modelPricing"),
    getSetting("modelVerification"),
  ]);
  const failures = await prisma.aiCall.groupBy({ by: ["model"], where: { success: false }, _count: true });
  const failByModel = new Map(failures.map((f) => [f.model, f._count]));
  const totalCost = byModel.reduce((a, m) => a + (m._sum.costUsd ?? 0), 0);
  const totalCalls = byModel.reduce((a, m) => a + m._count, 0);
  const totalCached = byModel.reduce((a, m) => a + (m._sum.cachedInputTokens ?? 0), 0);
  const totalInput = byModel.reduce((a, m) => a + (m._sum.inputTokens ?? 0), 0);
  const unpriced = byModel.filter((m) => !pricing[m.model]).map((m) => m.model);

  return (
    <>
      <PageHeader
        title="AI Performance"
        description="Token usage, cost, escalation and cache effectiveness, plus model comparison runs. Use the least expensive model that meets the clinically approved validation requirements."
      />
      {unpriced.length > 0 && (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <TriangleAlert className="size-4" aria-hidden /> No price configured for: {unpriced.join(", ")}. Costs for these models are not counted. Enter current
          prices in Settings.
        </p>
      )}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <StatCard label="API calls" value={totalCalls.toLocaleString()} icon={Activity} />
        <StatCard label="Total cost" value={formatUsd(totalCost)} icon={Coins} tone="info" />
        <StatCard label="Encounters classified" value={items} icon={Zap} />
        <StatCard label="Escalation rate" value={pct(escalated, items)} icon={Repeat} tone="warn" />
        <StatCard label="Cache hit rate" value={pct(cacheHits, items)} icon={Database} tone="good" />
        <StatCard label="Cached input tokens" value={pct(totalCached, totalInput)} icon={Database} hint={`${totalCached.toLocaleString()} tokens`} />
      </section>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Usage by model</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm tabular-nums">
              <thead className="bg-slate-50 text-left">
                <tr>
                  {["Model", "Calls", "Input", "Cached", "Output", "Reasoning", "Avg ms", "Retries", "Failures", "Cost", "Verified"].map((h) => (
                    <th key={h} className="px-3 py-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {byModel.map((m) => (
                  <tr key={m.model} className="border-t">
                    <td className="px-3 py-1.5 font-mono">{m.model}</td>
                    <td>{m._count}</td>
                    <td>{(m._sum.inputTokens ?? 0).toLocaleString()}</td>
                    <td>{(m._sum.cachedInputTokens ?? 0).toLocaleString()}</td>
                    <td>{(m._sum.outputTokens ?? 0).toLocaleString()}</td>
                    <td>{(m._sum.reasoningTokens ?? 0).toLocaleString()}</td>
                    <td>{Math.round(m._avg.durationMs ?? 0)}</td>
                    <td>{m._sum.retries ?? 0}</td>
                    <td>{failByModel.get(m.model) ?? 0}</td>
                    <td>{pricing[m.model] ? formatUsd(m._sum.costUsd) : "unpriced"}</td>
                    <td>{verification[m.model] ? (verification[m.model].ok ? "yes" : "FAILED") : "not checked"}</td>
                  </tr>
                ))}
                {byModel.length === 0 && (
                  <tr>
                    <td colSpan={11} className="p-4 text-center text-muted-foreground">
                      No AI calls yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Cost per day</CardTitle>
            <CardDescription>Last 30 days (priced models only)</CardDescription>
          </CardHeader>
          <CardContent>
            <DailyLine data={costByDay} dataKey="cost" label="Cost (USD)" format="usd" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Calls by purpose</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left">
                <tr>
                  <th className="px-3 py-2">Purpose</th>
                  <th>Outcome</th>
                  <th>Calls</th>
                </tr>
              </thead>
              <tbody>
                {byPurpose.map((p) => (
                  <tr key={p.purpose + p.success} className="border-t">
                    <td className="px-3 py-1.5">{p.purpose}</td>
                    <td>{p.success ? "success" : "failed"}</td>
                    <td className="tabular-nums">{p._count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Model comparison runs</CardTitle>
            <CardDescription>Same labelled cohort, different models. Metrics are development diagnostics.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm tabular-nums">
              <thead className="bg-slate-50 text-left">
                <tr>
                  {["Model", "Cohort", "Status", "F1", "Recall", "Precision", "Cost", "Date"].map((h) => (
                    <th key={h} className="px-3 py-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const m = (r.metrics ?? {}) as { f1?: number | null; recall?: number | null; precision?: number | null; costUsd?: number | null };
                  const f = (v?: number | null) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);
                  return (
                    <tr key={r.id} className="border-t">
                      <td className="px-3 py-1.5 font-mono">{r.model}</td>
                      <td>{r.cohort.toLowerCase()}</td>
                      <td>
                        <StatusBadge status={r.status} />
                      </td>
                      <td>{f(m.f1)}</td>
                      <td>{f(m.recall)}</td>
                      <td>{f(m.precision)}</td>
                      <td>{formatUsd(m.costUsd ?? null)}</td>
                      <td>{formatDate(r.createdAt)}</td>
                    </tr>
                  );
                })}
                {runs.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-4 text-center text-muted-foreground">
                      Run comparisons from Historical Validation.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
