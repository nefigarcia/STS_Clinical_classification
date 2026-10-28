import { prisma } from "@/lib/db/prisma";
import { getSetting } from "@/lib/settings";

export type Usage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number };

/** Cost from administrator-entered prices. Returns null when the model has no configured price. */
export function computeCost(
  model: string,
  u: Usage,
  pricing: Record<string, { inputPer1M: number; cachedInputPer1M: number; outputPer1M: number }>,
): number | null {
  const p = pricing[model];
  if (!p) return null;
  const uncached = Math.max(0, u.inputTokens - u.cachedInputTokens);
  return (uncached * p.inputPer1M + u.cachedInputTokens * p.cachedInputPer1M + u.outputTokens * p.outputPer1M) / 1_000_000;
}

export async function recordAiCall(entry: {
  jobId?: string | null;
  encounterId?: string | null;
  purpose: string;
  model: string;
  reasoningEffort?: string | null;
  usage: Usage;
  durationMs: number;
  retries: number;
  success: boolean;
  errorCode?: string | null;
}) {
  const pricing = await getSetting("modelPricing");
  const costUsd = computeCost(entry.model, entry.usage, pricing);
  await prisma.aiCall.create({
    data: {
      jobId: entry.jobId ?? null,
      encounterId: entry.encounterId ?? null,
      purpose: entry.purpose,
      model: entry.model,
      reasoningEffort: entry.reasoningEffort ?? null,
      inputTokens: entry.usage.inputTokens,
      cachedInputTokens: entry.usage.cachedInputTokens,
      outputTokens: entry.usage.outputTokens,
      reasoningTokens: entry.usage.reasoningTokens,
      costUsd,
      durationMs: entry.durationMs,
      retries: entry.retries,
      success: entry.success,
      errorCode: entry.errorCode ?? null,
    },
  });
  if (entry.jobId) {
    const total = entry.usage.inputTokens + entry.usage.outputTokens;
    await prisma.processingJob.update({
      where: { id: entry.jobId },
      data: {
        inputTokens: { increment: entry.usage.inputTokens },
        outputTokens: { increment: entry.usage.outputTokens },
        cachedTokens: { increment: entry.usage.cachedInputTokens },
        tokenUsage: { increment: total },
        ...(costUsd !== null ? { actualCost: { increment: costUsd } } : {}),
      },
    });
  }
  return costUsd;
}

export async function spendToday(): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const agg = await prisma.aiCall.aggregate({ _sum: { costUsd: true }, where: { createdAt: { gte: start } } });
  return agg._sum.costUsd ?? 0;
}

/** Rough pre-call estimate (≈4 chars/token) used for budget checks before spending. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
