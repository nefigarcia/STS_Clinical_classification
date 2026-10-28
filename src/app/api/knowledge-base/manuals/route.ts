import { after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { parseJson } from "@/lib/api";
import { createJob, triggerProcessing } from "@/lib/jobs/runner";
import { manualStats } from "@/lib/sts/manual-indexer";
import { audit } from "@/lib/audit";

export async function GET() {
  return handle("GET /api/knowledge-base/manuals", async () => {
    await requireRole("READ_ONLY");
    const manuals = await prisma.manualVersion.findMany({ orderBy: { createdAt: "desc" }, include: { approvedBy: { select: { email: true } } } });
    const withStats = await Promise.all(manuals.map(async (m) => ({ ...m, stats: await manualStats(m.id) })));
    return { manuals: withStats };
  });
}

const createSchema = z.object({
  sourceFileId: z.string(),
  version: z.string().trim().min(1).max(40),
  title: z.string().trim().max(200).optional(),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

/** Register an uploaded PDF as a manual version and queue identity check + semantic indexing. */
export async function POST(req: Request) {
  return handle("POST /api/knowledge-base/manuals", async () => {
    const user = await requireRole("ADMIN");
    const body = await parseJson(req, createSchema);
    const file = await prisma.sourceFile.findUnique({ where: { id: body.sourceFileId } });
    if (!file || !file.uploadComplete || file.kind !== "STS_MANUAL") throw new ApiError(400, "Upload the manual PDF first (kind STS_MANUAL)");
    if (await prisma.manualVersion.findUnique({ where: { version: body.version } })) throw new ApiError(409, "A manual with this version label already exists");
    const mv = await prisma.manualVersion.create({
      data: {
        version: body.version,
        title: body.title ?? null,
        fileName: file.fileName,
        sha256: file.sha256!,
        sourceFileId: file.id,
        effectiveFrom: body.effectiveFrom ? new Date(`${body.effectiveFrom}T00:00:00Z`) : null,
        effectiveTo: body.effectiveTo ? new Date(`${body.effectiveTo}T00:00:00Z`) : null,
      },
    });
    const job = await createJob({
      type: "MANUAL_INDEXING",
      createdById: user.id,
      manualVersionId: mv.id,
      sourceFileId: file.id,
      fileName: file.fileName,
      items: [{ refId: "parse" }],
    });
    await audit({
      userId: user.id,
      action: "manual.register",
      entityType: "ManualVersion",
      entityId: mv.id,
      metadata: { version: body.version, jobId: job.id },
    });
    after(() => triggerProcessing(job.id));
    return { manualVersionId: mv.id, jobId: job.id };
  });
}
