import { randomUUID } from "node:crypto";
import type { JobType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { log, errorSummary } from "@/lib/security/logger";
import { handlers, type HandlerOutcome } from "./handlers";

/**
 * Serverless-friendly job processing. Jobs and their items live in Postgres; a "tick"
 * processes items until a time budget is used, then releases its lease. Ticks are
 * triggered by (1) after() when a job is created, (2) self-chaining while work remains,
 * (3) Vercel Cron as a safety net, (4) `npm run worker` locally. No browser tab is needed.
 */

export async function createJob(input: {
  type: JobType;
  createdById?: string | null;
  sourceFileId?: string | null;
  manualVersionId?: string | null;
  fileName?: string | null;
  params?: Prisma.InputJsonValue;
  items: { encounterId?: string | null; refId?: string | null }[];
}) {
  return prisma.processingJob.create({
    data: {
      type: input.type,
      createdById: input.createdById ?? null,
      sourceFileId: input.sourceFileId ?? null,
      manualVersionId: input.manualVersionId ?? null,
      fileName: input.fileName ?? null,
      params: input.params,
      totalRecords: input.items.length,
      items: { create: input.items.map((i) => ({ encounterId: i.encounterId ?? null, refId: i.refId ?? null })) },
    },
  });
}

async function acquireLease(jobId: string, ms: number): Promise<string | null> {
  const owner = randomUUID();
  const now = new Date();
  const res = await prisma.processingJob.updateMany({
    where: {
      id: jobId,
      processingStatus: { in: ["QUEUED", "RUNNING"] },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { lockedUntil: new Date(now.getTime() + ms), lockOwner: owner, lastTickAt: now },
  });
  return res.count === 1 ? owner : null;
}

async function releaseLease(jobId: string, owner: string) {
  await prisma.processingJob.updateMany({ where: { id: jobId, lockOwner: owner }, data: { lockedUntil: null, lockOwner: null } });
}

const LEASE_MS = 90_000;
const HEARTBEAT_MS = 20_000;

export type TickResult = { jobId: string; processed: number; remaining: number; status: string; skipped?: boolean };

/** Process one job until the time budget is spent. Safe to call concurrently (lease-protected). */
export async function runJobTick(jobId: string, budgetMs = 240_000): Promise<TickResult> {
  // Short lease kept alive by a heartbeat: a crashed invocation frees the job within ~90 s,
  // while a live one is never mistaken for stalled (no duplicate processing).
  const owner = await acquireLease(jobId, LEASE_MS);
  if (!owner) {
    const j = await prisma.processingJob.findUnique({ where: { id: jobId }, select: { processingStatus: true } });
    return { jobId, processed: 0, remaining: -1, status: j?.processingStatus ?? "MISSING", skipped: true };
  }
  const deadline = Date.now() + budgetMs;
  let processed = 0;
  const heartbeat = setInterval(() => {
    const now = new Date();
    prisma.processingJob
      .updateMany({ where: { id: jobId, lockOwner: owner }, data: { lockedUntil: new Date(now.getTime() + LEASE_MS), lastTickAt: now } })
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  try {
    const job = await prisma.processingJob.update({ where: { id: jobId }, data: { processingStatus: "RUNNING" } });
    if (!job.startedAt) await prisma.processingJob.update({ where: { id: jobId }, data: { startedAt: new Date() } });
    const handler = handlers[job.type];

    // Leave headroom so an item (model call + retries) can finish inside the invocation.
    while (deadline - Date.now() > 45_000 || (processed === 0 && Date.now() < deadline)) {
      const current = await prisma.processingJob.findUnique({ where: { id: jobId }, select: { processingStatus: true } });
      if (current?.processingStatus !== "RUNNING") break; // paused / cancelled by a user
      const item = await prisma.jobItem.findFirst({ where: { jobId, status: "PENDING" }, orderBy: { id: "asc" } });
      if (!item) break;
      await prisma.jobItem.update({ where: { id: item.id }, data: { status: "RUNNING", attempts: { increment: 1 } } });
      let outcome: HandlerOutcome;
      try {
        outcome = await handler(job, item, { deadline: deadline - 10_000 });
      } catch (err) {
        outcome = { status: "FAILED", error: errorSummary(err) };
      }
      await prisma.jobItem.update({
        where: { id: item.id },
        data: {
          status: outcome.status === "PAUSE_JOB" || outcome.status === "YIELD" ? "PENDING" : outcome.status,
          error: outcome.error ?? null,
          costUsd: outcome.costUsd ?? undefined,
          escalated: outcome.escalated ?? undefined,
          cacheHit: outcome.cacheHit ?? undefined,
        },
      });
      if (outcome.status === "PAUSE_JOB") {
        await appendJobError(jobId, outcome.error ?? "Paused");
        await prisma.processingJob.update({ where: { id: jobId }, data: { processingStatus: "PAUSED", currentModel: outcome.model ?? undefined } });
        break;
      }
      processed++;
      // Time budget used mid-item: finished work is cached; the next invocation continues this item.
      if (outcome.status === "YIELD") break;
      await prisma.processingJob.update({
        where: { id: jobId },
        data: {
          processedRecords: { increment: outcome.status === "DONE" || outcome.status === "SKIPPED" ? 1 : 0 },
          failedRecords: { increment: outcome.status === "FAILED" ? 1 : 0 },
          currentModel: outcome.model ?? undefined,
        },
      });
      if (outcome.status === "FAILED") await appendJobError(jobId, outcome.error ?? "Item failed", item.encounterId ?? item.refId);
      if (outcome.newItems?.length) {
        await prisma.jobItem.createMany({ data: outcome.newItems.map((i) => ({ jobId, refId: i.refId ?? null, encounterId: i.encounterId ?? null })) });
        await prisma.processingJob.update({ where: { id: jobId }, data: { totalRecords: { increment: outcome.newItems.length } } });
      }
    }

    const remaining = await prisma.jobItem.count({ where: { jobId, status: { in: ["PENDING", "RUNNING"] } } });
    const after = await prisma.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    if (remaining === 0 && after.processingStatus === "RUNNING") {
      const failed = await prisma.jobItem.count({ where: { jobId, status: "FAILED" } });
      const finalStatus = failed > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
      if (handler.finalize) await handler.finalize(after);
      await prisma.processingJob.update({ where: { id: jobId }, data: { processingStatus: finalStatus, completedAt: new Date() } });
      log.info("job completed", { jobId, jobType: after.type, status: finalStatus, processed: after.processedRecords, failed });
      return { jobId, processed, remaining: 0, status: finalStatus };
    }
    return { jobId, processed, remaining, status: after.processingStatus };
  } finally {
    clearInterval(heartbeat);
    // Items left RUNNING by a crashed tick are recovered by recoverStaleItems().
    await releaseLease(jobId, owner);
  }
}

async function appendJobError(jobId: string, message: string, ref?: string | null) {
  const job = await prisma.processingJob.findUnique({ where: { id: jobId }, select: { errors: true } });
  const errors = Array.isArray(job?.errors) ? (job!.errors as Prisma.JsonArray) : [];
  errors.push({ at: new Date().toISOString(), ref: ref ?? null, message: message.slice(0, 500) });
  await prisma.processingJob.update({ where: { id: jobId }, data: { errors: errors.slice(-200) } });
}

/** Return items stuck in RUNNING (crashed invocation) to PENDING once their job lease expired. */
export async function recoverStaleItems() {
  const stale = await prisma.processingJob.findMany({
    where: { processingStatus: "RUNNING", OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
    select: { id: true },
  });
  if (stale.length) {
    await prisma.jobItem.updateMany({ where: { jobId: { in: stale.map((s) => s.id) }, status: "RUNNING" }, data: { status: "PENDING" } });
  }
}

/** Process all runnable jobs within one budget. Returns whether work remains. */
export async function processRunnableJobs(budgetMs: number, onlyJobId?: string): Promise<{ results: TickResult[]; workRemains: boolean }> {
  await recoverStaleItems();
  const deadline = Date.now() + budgetMs;
  const jobs = await prisma.processingJob.findMany({
    where: { processingStatus: { in: ["QUEUED", "RUNNING"] }, ...(onlyJobId ? { id: onlyJobId } : {}) },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const results: TickResult[] = [];
  for (const j of jobs) {
    const left = deadline - Date.now();
    if (left < 10_000) break;
    results.push(await runJobTick(j.id, left - 5_000));
  }
  const workRemains = (await prisma.processingJob.count({ where: { processingStatus: { in: ["QUEUED", "RUNNING"] } } })) > 0;
  return { results, workRemains };
}

function baseUrl(): string | null {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return process.env.AUTH_URL ?? null;
}

/**
 * Fire a new processing invocation (fresh time budget). The endpoint replies immediately
 * and works in after(), so this await is short.
 */
export async function triggerProcessing(jobId?: string) {
  const url = baseUrl();
  const secret = env().CRON_SECRET;
  if (!url || !secret) {
    log.warn("cannot chain job processing: AUTH_URL/VERCEL_URL or CRON_SECRET missing; waiting for cron/worker");
    return;
  }
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${secret}` };
    // Vercel deployment protection bypass, if configured.
    if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    await fetch(`${url}/api/cron/process-jobs${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ""}`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    log.warn(`job trigger failed: ${errorSummary(err)}`);
  }
}
