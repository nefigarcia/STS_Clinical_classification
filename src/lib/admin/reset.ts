import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";

/**
 * Reset AI classification results so encounters can be re-classified from zero (testing only).
 * Deletes predictions + evidence, reviewer decisions on them, reviewer-feedback candidate examples,
 * classification cache, classification/evaluation jobs with their AI-call usage, and evaluation runs.
 * Keeps patients, encounters, notes, files, STS manual + rules, historical labels, users, settings,
 * prompt versions and the audit log. Disabled when APP_ENV=production.
 */

export type ResetCounts = {
  predictions: number;
  reviewDecisions: number;
  reviewerFeedbackExamples: number;
  classificationCache: number;
  jobs: number;
  aiCalls: number;
  evaluationRuns: number;
  screeningCache: number | null;
  runningJobs: number;
};

export function resetAllowed(): boolean {
  return env().APP_ENV !== "production";
}

const JOB_TYPES = ["CLASSIFICATION", "EVALUATION"] as ("CLASSIFICATION" | "EVALUATION")[];

async function scope() {
  const jobIds = (await prisma.processingJob.findMany({ where: { type: { in: JOB_TYPES } }, select: { id: true } })).map((j) => j.id);
  return { jobIds, aiCallWhere: { OR: [{ jobId: { in: jobIds } }, { jobId: null, purpose: { not: "manual-embedding" } }] } };
}

export async function previewReset(includeScreeningCache: boolean): Promise<ResetCounts> {
  const { jobIds, aiCallWhere } = await scope();
  return {
    predictions: await prisma.complicationPrediction.count(),
    reviewDecisions: await prisma.reviewDecision.count(),
    reviewerFeedbackExamples: await prisma.historicalExample.count({ where: { source: "REVIEWER_FEEDBACK" } }),
    classificationCache: await prisma.classificationCache.count(),
    jobs: jobIds.length,
    aiCalls: await prisma.aiCall.count({ where: aiCallWhere }),
    evaluationRuns: await prisma.evaluationRun.count(),
    screeningCache: includeScreeningCache ? await prisma.noteScreenCache.count() : null,
    runningJobs: await prisma.processingJob.count({ where: { type: { in: JOB_TYPES }, processingStatus: { in: ["QUEUED", "RUNNING"] } } }),
  };
}

export async function resetClassifications(opts: { includeScreeningCache: boolean; userId: string | null; via: "ui" | "cli" }): Promise<ResetCounts> {
  if (!resetAllowed()) throw new Error("Resetting classification data is disabled when APP_ENV=production.");
  const counts = await previewReset(opts.includeScreeningCache);
  if (counts.runningJobs > 0) throw new Error(`${counts.runningJobs} classification job(s) are queued or running. Cancel them in AI Processing first.`);
  const { jobIds, aiCallWhere } = await scope();
  await prisma.$transaction(async (tx) => {
    await tx.reviewDecision.deleteMany({});
    await tx.historicalExample.deleteMany({ where: { source: "REVIEWER_FEEDBACK" } });
    await tx.predictionEvidence.deleteMany({});
    await tx.complicationPrediction.deleteMany({});
    await tx.classificationCache.deleteMany({});
    await tx.aiCall.deleteMany({ where: aiCallWhere });
    await tx.processingJob.deleteMany({ where: { id: { in: jobIds } } }); // job items cascade
    await tx.evaluationRun.deleteMany({});
    if (opts.includeScreeningCache) await tx.noteScreenCache.deleteMany({});
    await tx.auditLog.create({
      data: { userId: opts.userId, action: "admin.reset_classifications", entityType: "System", metadata: { ...counts, via: opts.via } },
    });
  });
  return counts;
}
