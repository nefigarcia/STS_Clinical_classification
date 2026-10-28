import { prisma } from "@/lib/db/prisma";

const LIVE = { supersededAt: null, classificationStatus: { not: "EXCLUDED" as const } };

export async function dashboardStats() {
  const [patients, encounters, notes, aiClassifications, byReview, distribution, jobsByDay, costByDay, totals] = await Promise.all([
    prisma.patient.count(),
    prisma.encounter.count(),
    prisma.clinicalNote.count(),
    prisma.complicationPrediction.count({ where: { ...LIVE, classificationStatus: { notIn: ["EXCLUDED", "REVIEWER_ADDED"] } } }),
    prisma.complicationPrediction.groupBy({ by: ["reviewStatus"], where: LIVE, _count: true }),
    prisma.$queryRaw<{ label: string; n: number }[]>`
      SELECT coalesce("finalComplication", "predictedComplication") AS label, count(*)::int AS n
      FROM "ComplicationPrediction"
      WHERE "supersededAt" IS NULL AND "classificationStatus" <> 'EXCLUDED' AND "reviewStatus" <> 'REJECTED'
      GROUP BY 1 ORDER BY n DESC LIMIT 12`,
    prisma.$queryRaw<{ day: string; n: number }[]>`
      SELECT to_char(date_trunc('day', "updatedAt"), 'YYYY-MM-DD') AS day, count(*)::int AS n
      FROM "JobItem" WHERE status = 'DONE' AND "updatedAt" > now() - interval '30 days'
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<{ day: string; cost: number | null; tokens: number }[]>`
      SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day, sum("costUsd")::float AS cost,
             sum("inputTokens" + "outputTokens")::int AS tokens
      FROM "AiCall" WHERE "createdAt" > now() - interval '30 days'
      GROUP BY 1 ORDER BY 1`,
    prisma.aiCall.aggregate({ _sum: { costUsd: true, inputTokens: true, outputTokens: true }, _count: true }),
  ]);
  const review = Object.fromEntries(byReview.map((r) => [r.reviewStatus, r._count])) as Record<string, number>;
  return {
    patients,
    encounters,
    notes,
    aiClassifications,
    review: {
      PENDING: review.PENDING ?? 0,
      APPROVED: review.APPROVED ?? 0,
      CORRECTED: review.CORRECTED ?? 0,
      REJECTED: review.REJECTED ?? 0,
      NEEDS_REVIEW: review.NEEDS_REVIEW ?? 0,
    },
    distribution,
    jobsByDay,
    costByDay,
    totals: { calls: totals._count, costUsd: totals._sum.costUsd, tokens: (totals._sum.inputTokens ?? 0) + (totals._sum.outputTokens ?? 0) },
  };
}

export type DashboardStats = Awaited<ReturnType<typeof dashboardStats>>;
