import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { assembleUpload } from "@/lib/storage";
import { previewUpload } from "@/lib/data/preview";
import { audit } from "@/lib/audit";

export const maxDuration = 120;

/** Assemble chunks, verify signature/size, and return a preview for tabular files. */
export async function POST(_req: NextRequest, ctx: RouteContext<"/api/upload/[id]/complete">) {
  return handle("POST /api/upload/[id]/complete", async () => {
    const user = await requireRole("REVIEWER");
    const { id } = await ctx.params;
    const file = await prisma.sourceFile.findUnique({ where: { id } });
    if (!file) throw new ApiError(404, "Upload not found");
    if (file.uploadedById !== user.id) throw new ApiError(403, "Only the uploader can complete this upload");
    try {
      if (!file.uploadComplete) await assembleUpload(id);
    } catch (err) {
      await prisma.sourceFile.update({ where: { id }, data: { status: "FAILED" } });
      throw new ApiError(400, err instanceof Error ? err.message : "Upload failed");
    }
    const fresh = await prisma.sourceFile.findUniqueOrThrow({ where: { id } });
    const duplicateOf = await prisma.sourceFile.findFirst({
      where: { sha256: fresh.sha256, id: { not: id }, status: "IMPORTED" },
      select: { id: true, fileName: true, importedAt: true },
    });
    await audit({ userId: user.id, action: "upload.complete", entityType: "SourceFile", entityId: id, metadata: { duplicateFile: Boolean(duplicateOf) } });
    if (fresh.fileType === "pdf") return { id, fileType: "pdf", sha256: fresh.sha256, duplicateOf };
    return { id, fileType: fresh.fileType, sha256: fresh.sha256, duplicateOf, ...(await previewUpload(fresh)) };
  });
}
