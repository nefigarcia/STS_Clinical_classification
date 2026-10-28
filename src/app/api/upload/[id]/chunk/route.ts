import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { CHUNK_BYTES } from "@/lib/storage";
import { intParam, searchParams } from "@/lib/api";

/** Receive one raw chunk (application/octet-stream). Idempotent per index. */
export async function PUT(req: NextRequest, ctx: RouteContext<"/api/upload/[id]/chunk">) {
  return handle("PUT /api/upload/[id]/chunk", async () => {
    const user = await requireRole("REVIEWER");
    const { id } = await ctx.params;
    const file = await prisma.sourceFile.findUnique({ where: { id } });
    if (!file) throw new ApiError(404, "Upload not found");
    if (file.uploadedById !== user.id) throw new ApiError(403, "Only the uploader can add chunks");
    if (file.uploadComplete) throw new ApiError(409, "Upload already completed");
    const index = intParam(searchParams(req).get("index"), -1, -1, 100_000);
    if (index < 0 || index >= file.expectedChunks) throw new ApiError(400, "Invalid chunk index");
    const bytes = Buffer.from(await req.arrayBuffer());
    if (bytes.length === 0 || bytes.length > CHUNK_BYTES) throw new ApiError(400, "Invalid chunk size");
    await prisma.uploadChunk.upsert({
      where: { sourceFileId_index: { sourceFileId: id, index } },
      create: { sourceFileId: id, index, bytes },
      update: { bytes },
    });
    return { ok: true, index };
  });
}
