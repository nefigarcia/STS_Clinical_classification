import type { JobItem, JobType, Prisma, ProcessingJob } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { classifyEncounter, BudgetExceededError, GateClosedError } from "@/lib/ai/classifier";
import { modelConfig } from "@/lib/ai/openai-client";
import { parseAndStoreManual, embedRuleBatch, finishIndexing } from "@/lib/sts/manual-indexer";
import { prepareHistoricalExample } from "@/lib/validation/historical-prep";
import { computeMetrics, type EncounterLabels } from "@/lib/validation/metrics";
import { getSetting } from "@/lib/settings";
import { errorSummary } from "@/lib/security/logger";

export type HandlerOutcome = {
  status: "DONE" | "FAILED" | "SKIPPED" | "PAUSE_JOB";
  error?: string;
  costUsd?: number | null;
  escalated?: boolean;
  cacheHit?: boolean;
  model?: string;
  newItems?: { refId?: string; encounterId?: string }[];
};

type Handler = ((job: ProcessingJob, item: JobItem) => Promise<HandlerOutcome>) & {
  finalize?: (job: ProcessingJob) => Promise<void>;
};

async function escalationStats(jobId: string) {
  const [escalated, processed] = await Promise.all([
    prisma.jobItem.count({ where: { jobId, escalated: true } }),
    prisma.jobItem.count({ where: { jobId, status: "DONE" } }),
  ]);
  return { escalated, processed };
}

const classification: Handler = async (job, item) => {
  if (!item.encounterId) return { status: "SKIPPED", error: "No encounter" };
  const params = (job.params ?? {}) as { forceEscalation?: boolean };
  try {
    const r = await classifyEncounter(item.encounterId, {
      jobId: job.id,
      forceEscalation: params.forceEscalation,
      escalationStats: await escalationStats(job.id),
    });
    return { status: "DONE", costUsd: r.costUsd, escalated: r.escalated, cacheHit: r.cacheHit, model: r.modelUsed };
  } catch (err) {
    if (err instanceof BudgetExceededError || err instanceof GateClosedError) {
      return { status: "PAUSE_JOB", error: err.message, model: modelConfig().primary };
    }
    return { status: "FAILED", error: errorSummary(err) };
  }
};

const manualIndexing: Handler = async (job, item) => {
  const manualVersionId = job.manualVersionId!;
  if (item.refId === "parse") {
    try {
      const r = await parseAndStoreManual(manualVersionId);
      await prisma.processingJob.update({ where: { id: job.id }, data: { result: r as unknown as Prisma.InputJsonValue } });
      return { status: "DONE", newItems: r.toEmbed > 0 ? [{ refId: "embed" }] : [] };
    } catch (err) {
      await prisma.manualVersion.updateMany({ where: { id: manualVersionId, status: { not: "REJECTED" } }, data: { status: "FAILED" } });
      return { status: "FAILED", error: errorSummary(err) };
    }
  }
  if (item.refId === "embed") {
    try {
      const n = await embedRuleBatch(manualVersionId, job.id);
      // One batch per item keeps each step well inside serverless time limits.
      return { status: "DONE", newItems: n > 0 ? [{ refId: "embed" }] : [], model: modelConfig().embedding };
    } catch (err) {
      return { status: "FAILED", error: errorSummary(err) };
    }
  }
  return { status: "SKIPPED" };
};
manualIndexing.finalize = async (job) => {
  if (!job.manualVersionId) return;
  const mv = await prisma.manualVersion.findUnique({ where: { id: job.manualVersionId } });
  if (mv && mv.status === "INDEXING") await finishIndexing(mv.id);
};

const historicalPrep: Handler = async (_job, item) => {
  if (!item.refId) return { status: "SKIPPED" };
  const r = await prepareHistoricalExample(item.refId);
  return { status: r.skipped ? "SKIPPED" : "DONE" };
};

const evaluation: Handler = async (job, item) => {
  if (!item.encounterId) return { status: "SKIPPED" };
  const params = (job.params ?? {}) as { model: string; evaluationRunId: string };
  try {
    const r = await classifyEncounter(item.encounterId, { jobId: job.id, evaluationModel: params.model });
    const run = await prisma.evaluationRun.findUniqueOrThrow({ where: { id: params.evaluationRunId } });
    const results = (Array.isArray(run.results) ? run.results : []) as unknown as { encounterId: string; predicted: unknown[] }[];
    results.push({
      encounterId: item.encounterId,
      predicted: r.events
        .filter((e) => e.classificationStatus !== "EXCLUDED" && e.classificationStatus !== "INSUFFICIENT_EVIDENCE")
        .map((e) => ({
          label: e.complication,
          uncertain: e.classificationStatus !== "SUGGESTED" || e.reviewStatus === "NEEDS_REVIEW",
          evidenceVerified: e.evidence.length ? e.evidence.every((x) => x.verified) : false,
          evidenceNoteIds: e.evidence.map((x) => x.noteId),
        })),
    });
    await prisma.evaluationRun.update({ where: { id: run.id }, data: { results: results as unknown as Prisma.InputJsonValue, status: "RUNNING" } });
    return { status: "DONE", costUsd: r.costUsd, model: r.modelUsed };
  } catch (err) {
    if (err instanceof BudgetExceededError || err instanceof GateClosedError) return { status: "PAUSE_JOB", error: err.message };
    return { status: "FAILED", error: errorSummary(err) };
  }
};
evaluation.finalize = async (job) => {
  const params = (job.params ?? {}) as { evaluationRunId: string };
  const run = await prisma.evaluationRun.findUnique({ where: { id: params.evaluationRunId } });
  if (!run) return;
  const results = (Array.isArray(run.results) ? run.results : []) as unknown as { encounterId: string; predicted: EncounterLabels["predicted"] }[];
  const examples = await prisma.historicalExample.findMany({ where: { cohort: run.cohort, encounterId: { in: results.map((r) => r.encounterId) } } });
  const data: EncounterLabels[] = results.map((r) => {
    const exs = examples.filter((e) => e.encounterId === r.encounterId);
    return {
      encounterId: r.encounterId,
      mrn: exs[0]?.mrn ?? "",
      csn: exs[0]?.csn ?? "",
      date: exs[0]?.dateOfService?.toISOString().slice(0, 10) ?? null,
      expected: exs.map((e) => e.originalLabel),
      expectedSupportingNoteIds: exs.filter((e) => e.quality === "VERIFIED").flatMap((e) => e.supportingNoteIds),
      predicted: r.predicted,
      processed: true,
    };
  });
  const { metrics } = computeMetrics(data, await getSetting("labelMap"));
  const cost = await prisma.aiCall.aggregate({ _sum: { costUsd: true, inputTokens: true, outputTokens: true }, where: { jobId: job.id } });
  await prisma.evaluationRun.update({
    where: { id: run.id },
    data: {
      metrics: {
        ...metrics,
        costUsd: cost._sum.costUsd,
        inputTokens: cost._sum.inputTokens,
        outputTokens: cost._sum.outputTokens,
      } as unknown as Prisma.InputJsonValue,
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
};

export const handlers: Record<JobType, Handler> = {
  CLASSIFICATION: classification,
  MANUAL_INDEXING: manualIndexing,
  HISTORICAL_PREP: historicalPrep,
  EVALUATION: evaluation,
};
