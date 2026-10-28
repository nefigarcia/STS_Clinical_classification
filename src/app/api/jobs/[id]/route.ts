import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { parseJson } from "@/lib/api";
import { triggerProcessing } from "@/lib/jobs/runner";
import { audit } from "@/lib/audit";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/jobs/[id]">) {
  return handle("GET /api/jobs/[id]", async () => {
    await requireRole("READ_ONLY");
    const { id } = await ctx.params;
    const job = await prisma.processingJob.findUnique({ where: { id } });
    if (!job) throw new ApiError(404, "Job not found");
    const [byStatus, byModel, escalated, cacheHits] = await Promise.all([
      prisma.jobItem.groupBy({ by: ["status"], where: { jobId: id }, _count: true }),
      prisma.aiCall.groupBy({
        by: ["model"],
        where: { jobId: id },
        _sum: { inputTokens: true, outputTokens: true, cachedInputTokens: true, costUsd: true },
        _count: true,
      }),
      prisma.jobItem.count({ where: { jobId: id, escalated: true } }),
      prisma.jobItem.count({ where: { jobId: id, cacheHit: true } }),
    ]);
    return { job, items: Object.fromEntries(byStatus.map((s) => [s.status, s._count])), byModel, escalated, cacheHits };
  });
}

const patchSchema = z.object({ action: z.enum(["pause", "resume", "cancel", "retry_failed"]) });

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/jobs/[id]">) {
  return handle("PATCH /api/jobs/[id]", async () => {
    const user = await requireRole("REVIEWER");
    const { id } = await ctx.params;
    const { action } = await parseJson(req, patchSchema);
    const job = await prisma.processingJob.findUnique({ where: { id } });
    if (!job) throw new ApiError(404, "Job not found");
    if (action === "pause") {
      if (!["QUEUED", "RUNNING"].includes(job.processingStatus)) throw new ApiError(409, "Job is not running");
      await prisma.processingJob.update({ where: { id }, data: { processingStatus: "PAUSED" } });
    } else if (action === "cancel") {
      await prisma.processingJob.update({ where: { id }, data: { processingStatus: "CANCELLED", completedAt: new Date() } });
      await prisma.jobItem.updateMany({ where: { jobId: id, status: "PENDING" }, data: { status: "SKIPPED" } });
    } else {
      // resume (interrupted/paused) or retry failed items
      if (action === "retry_failed") {
        const n = await prisma.jobItem.updateMany({ where: { jobId: id, status: "FAILED" }, data: { status: "PENDING", error: null } });
        await prisma.processingJob.update({ where: { id }, data: { failedRecords: { decrement: n.count } } });
      }
      await prisma.jobItem.updateMany({ where: { jobId: id, status: "RUNNING" }, data: { status: "PENDING" } });
      await prisma.processingJob.update({ where: { id }, data: { processingStatus: "QUEUED", completedAt: null, lockedUntil: null, lockOwner: null } });
      after(() => triggerProcessing(id));
    }
    await audit({ userId: user.id, action: `job.${action}`, entityType: "ProcessingJob", entityId: id });
    return { ok: true };
  });
}
