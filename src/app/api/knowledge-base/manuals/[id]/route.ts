import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { parseJson } from "@/lib/api";
import { createJob, triggerProcessing } from "@/lib/jobs/runner";
import { audit } from "@/lib/audit";

const schema = z.object({
  action: z.enum(["approve", "retire", "set_default", "reindex", "update_dates"]),
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
  confirmIdentity: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/knowledge-base/manuals/[id]">) {
  return handle("PATCH /api/knowledge-base/manuals/[id]", async () => {
    const user = await requireRole("ADMIN");
    const { id } = await ctx.params;
    const body = await parseJson(req, schema);
    const mv = await prisma.manualVersion.findUnique({ where: { id } });
    if (!mv) throw new ApiError(404, "Manual not found");
    switch (body.action) {
      case "approve": {
        if (mv.status !== "INDEXED") throw new ApiError(409, `Manual must be INDEXED to approve (currently ${mv.status})`);
        const identity = mv.identityCheck as { isStsChsdManual?: boolean } | null;
        if (!identity?.isStsChsdManual) throw new ApiError(409, "Identity check did not confirm an STS CHSD Training Manual");
        if (!body.confirmIdentity) throw new ApiError(400, "Administrator must confirm the document is the official STS CHSD Training Manual");
        const rules = await prisma.sTSManualRule.count({ where: { manualVersionId: id } });
        if (rules === 0) throw new ApiError(409, "No rules were extracted");
        const hasDefault = await prisma.manualVersion.count({ where: { status: "APPROVED", isDefault: true } });
        await prisma.manualVersion.update({
          where: { id },
          data: { status: "APPROVED", approvedById: user.id, approvedAt: new Date(), isDefault: hasDefault === 0 ? true : mv.isDefault },
        });
        // Rule changes invalidate cached classifications.
        await prisma.classificationCache.updateMany({ where: { invalidatedAt: null }, data: { invalidatedAt: new Date() } });
        break;
      }
      case "retire":
        await prisma.manualVersion.update({ where: { id }, data: { status: "RETIRED", isDefault: false } });
        await prisma.classificationCache.updateMany({ where: { manualVersion: mv.version, invalidatedAt: null }, data: { invalidatedAt: new Date() } });
        break;
      case "set_default":
        if (mv.status !== "APPROVED") throw new ApiError(409, "Only approved manuals can be default");
        await prisma.$transaction([
          prisma.manualVersion.updateMany({ data: { isDefault: false } }),
          prisma.manualVersion.update({ where: { id }, data: { isDefault: true } }),
        ]);
        break;
      case "update_dates":
        await prisma.manualVersion.update({
          where: { id },
          data: {
            effectiveFrom: body.effectiveFrom === undefined ? undefined : body.effectiveFrom ? new Date(`${body.effectiveFrom}T00:00:00Z`) : null,
            effectiveTo: body.effectiveTo === undefined ? undefined : body.effectiveTo ? new Date(`${body.effectiveTo}T00:00:00Z`) : null,
          },
        });
        break;
      case "reindex": {
        if (mv.status === "APPROVED") throw new ApiError(409, "Retire the manual before re-indexing");
        const job = await createJob({
          type: "MANUAL_INDEXING",
          createdById: user.id,
          manualVersionId: id,
          sourceFileId: mv.sourceFileId,
          fileName: mv.fileName,
          items: [{ refId: "parse" }],
        });
        after(() => triggerProcessing(job.id));
        break;
      }
    }
    await audit({ userId: user.id, action: `manual.${body.action}`, entityType: "ManualVersion", entityId: id });
    return { ok: true };
  });
}
