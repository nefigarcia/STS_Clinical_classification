import Link from "next/link";
import { Users, Hospital, FileText, Sparkles, Clock, CheckCircle2, XCircle, AlertTriangle, DollarSign } from "lucide-react";
import { requirePageRole } from "@/lib/auth/guard";
import { dashboardStats } from "@/lib/stats";
import { PageHeader, StatCard, formatUsd } from "@/components/common";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DailyLine, HorizontalBars, StatusBars } from "@/components/charts/charts";
import { buttonVariants } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  await requirePageRole("READ_ONLY");
  const s = await dashboardStats();
  const reviewed = s.review.APPROVED + s.review.CORRECTED + s.review.REJECTED;
  const totalReview = reviewed + s.review.PENDING + s.review.NEEDS_REVIEW;
  const statusData = [
    { status: "PENDING", label: "Pending", n: s.review.PENDING },
    { status: "NEEDS_REVIEW", label: "Needs review", n: s.review.NEEDS_REVIEW },
    { status: "APPROVED", label: "Approved", n: s.review.APPROVED },
    { status: "CORRECTED", label: "Corrected", n: s.review.CORRECTED },
    { status: "REJECTED", label: "Rejected", n: s.review.REJECTED },
  ];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Overview of imported clinical data, AI-suggested complications and clinical review progress. AI suggestions are not final until a clinical reviewer approves them."
        actions={
          <Link href="/review" className={buttonVariants()}>
            Open review queue
          </Link>
        }
      />
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-4 2xl:grid-cols-8">
        <StatCard label="Patients" value={s.patients} icon={Users} />
        <StatCard label="Encounters" value={s.encounters} icon={Hospital} />
        <StatCard label="Notes" value={s.notes.toLocaleString()} icon={FileText} />
        <StatCard label="AI classifications" value={s.aiClassifications} icon={Sparkles} tone="info" />
        <StatCard label="Pending reviews" value={s.review.PENDING} icon={Clock} />
        <StatCard
          label="Approved"
          value={s.review.APPROVED + s.review.CORRECTED}
          icon={CheckCircle2}
          tone="good"
          hint={`incl. ${s.review.CORRECTED} corrected`}
        />
        <StatCard label="Rejected" value={s.review.REJECTED} icon={XCircle} tone="bad" />
        <StatCard label="Needs review" value={s.review.NEEDS_REVIEW} icon={AlertTriangle} tone="warn" />
      </section>

      <div className="mt-6 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Complication distribution</CardTitle>
            <CardDescription>Current suggestions and reviewer-final labels (rejected excluded)</CardDescription>
          </CardHeader>
          <CardContent>
            <HorizontalBars data={s.distribution} valueLabel="Complications" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Review progress</CardTitle>
            <CardDescription>
              {totalReview ? `${reviewed} of ${totalReview} reviewed (${Math.round((reviewed / totalReview) * 100)}%)` : "No predictions yet"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div
              className="mb-4 h-2 overflow-hidden rounded-full bg-slate-100"
              role="progressbar"
              aria-valuenow={reviewed}
              aria-valuemin={0}
              aria-valuemax={totalReview}
              aria-label="Review progress"
            >
              <div className="h-full rounded-full bg-emerald-600" style={{ width: `${totalReview ? (reviewed / totalReview) * 100 : 0}%` }} />
            </div>
            <StatusBars data={statusData} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Processing activity</CardTitle>
            <CardDescription>Job items completed per day (last 30 days)</CardDescription>
          </CardHeader>
          <CardContent>
            <DailyLine data={s.jobsByDay} dataKey="n" label="Items processed" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle>AI usage and cost</CardTitle>
              <CardDescription>Tokens per day (last 30 days) · cost uses administrator-entered prices</CardDescription>
            </div>
            <div className="text-right text-sm">
              <div className="flex items-center justify-end gap-1 font-semibold">
                <DollarSign className="size-4" aria-hidden />
                {s.totals.calls === 0 ? "$0.00" : formatUsd(s.totals.costUsd)}
              </div>
              <div className="text-xs text-muted-foreground">
                {s.totals.tokens.toLocaleString()} tokens · {s.totals.calls} calls
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <DailyLine data={s.costByDay} dataKey="tokens" label="Tokens" format="compact" />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
