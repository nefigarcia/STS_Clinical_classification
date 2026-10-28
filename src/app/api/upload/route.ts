import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { parseJson } from "@/lib/api";
import { CHUNK_BYTES, typeFromName } from "@/lib/storage";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";

const initSchema = z.object({
  fileName: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  kind: z.enum(["CLINICAL_NOTES", "HISTORICAL_COMPLICATIONS", "STS_MANUAL"]),
  dataClassification: z.enum(["SYNTHETIC", "DEIDENTIFIED", "PHI"]),
});

/** List uploaded source files (metadata only). */
export async function GET() {
  return handle("GET /api/upload", async () => {
    await requireRole("READ_ONLY");
    const files = await prisma.sourceFile.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        fileName: true,
        fileType: true,
        kind: true,
        dataClassification: true,
        sizeBytes: true,
        status: true,
        sheetName: true,
        createdAt: true,
        importedAt: true,
        importReport: true,
        uploadComplete: true,
      },
    });
    return { files };
  });
}

/** Begin a chunked upload. Bytes are then PUT to /api/upload/[id]/chunk?index=n. */
export async function POST(req: Request) {
  return handle("POST /api/upload", async () => {
    const body = await parseJson(req, initSchema);
    const user = await requireRole(body.kind === "STS_MANUAL" ? "ADMIN" : "REVIEWER");
    const { type, error } = typeFromName(body.fileName);
    if (!type) throw new ApiError(400, error!);
    if (body.kind === "STS_MANUAL" && type !== "pdf") throw new ApiError(400, "The STS manual must be a PDF");
    if (body.kind !== "STS_MANUAL" && type === "pdf") throw new ApiError(400, "Clinical datasets must be .xlsx or .csv");
    if (body.sizeBytes > env().MAX_UPLOAD_MB * 1024 * 1024) throw new ApiError(413, `File exceeds ${env().MAX_UPLOAD_MB} MB`);
    const expectedChunks = Math.ceil(body.sizeBytes / CHUNK_BYTES);
    const file = await prisma.sourceFile.create({
      data: {
        fileName: body.fileName,
        fileType: type,
        kind: body.kind,
        dataClassification: body.dataClassification,
        sizeBytes: body.sizeBytes,
        expectedChunks,
        uploadedById: user.id,
      },
    });
    await audit({
      userId: user.id,
      action: "upload.start",
      entityType: "SourceFile",
      entityId: file.id,
      metadata: { kind: body.kind, dataClassification: body.dataClassification, sizeBytes: body.sizeBytes },
    });
    return { id: file.id, chunkBytes: CHUNK_BYTES, expectedChunks };
  });
}
