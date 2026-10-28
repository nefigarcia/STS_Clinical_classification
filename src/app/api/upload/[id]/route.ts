import type { NextRequest } from "next/server";
import { after } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { parseJson } from "@/lib/api";
import { previewUpload } from "@/lib/data/preview";
import { importClinicalNotes, importHistorical, loadTable, validateTable } from "@/lib/data/import-service";
import { mappingSchema } from "@/lib/data/column-mapping";
import { createJob, triggerProcessing } from "@/lib/jobs/runner";
import { audit } from "@/lib/audit";

export const maxDuration = 300;

const actionSchema = z.object({
  action: z.enum(["preview", "validate", "import"]),
  sheetName: z.string().nullable().optional(),
  mapping: mappingSchema.optional(),
});

export async function POST(req: NextRequest, ctx: RouteContext<"/api/upload/[id]">) {
  return handle("POST /api/upload/[id]", async () => {
    const user = await requireRole("REVIEWER");
    const { id } = await ctx.params;
    const body = await parseJson(req, actionSchema);
    const file = await prisma.sourceFile.findUnique({ where: { id } });
    if (!file || !file.uploadComplete) throw new ApiError(404, "Completed upload not found");
    if (file.kind === "STS_MANUAL") throw new ApiError(400, "Use the STS Knowledge Base to index manuals");

    if (body.action === "preview") return previewUpload(file, body.sheetName);
    if (!body.mapping) throw new ApiError(400, "Column mapping is required");
    const kind = file.kind;
    const table = await loadTable(file, body.sheetName);

    if (body.action === "validate") {
      const { report } = validateTable(kind, table, body.mapping);
      await prisma.sourceFile.update({
        where: { id },
        data: {
          status: "VALIDATED",
          sheetName: body.sheetName ?? null,
          columnMapping: body.mapping as Prisma.InputJsonValue,
          importReport: report as unknown as Prisma.InputJsonValue,
        },
      });
      await audit({
        userId: user.id,
        action: "upload.validate",
        entityType: "SourceFile",
        entityId: id,
        metadata: { totalRows: report.totalRows, invalidRows: report.invalidRows },
      });
      return { report };
    }

    // import
    if (file.status === "IMPORTED") throw new ApiError(409, "This file has already been imported");
    const result = kind === "CLINICAL_NOTES" ? await importClinicalNotes(id, table, body.mapping) : await importHistorical(id, table, body.mapping);
    await prisma.sourceFile.update({
      where: { id },
      data: {
        status: "IMPORTED",
        importedAt: new Date(),
        sheetName: body.sheetName ?? null,
        columnMapping: body.mapping as Prisma.InputJsonValue,
        importReport: result as unknown as Prisma.InputJsonValue,
      },
    });
    let prepJobId: string | null = null;
    // Historical labels (or newly imported notes that historical labels may match) get local evidence mapping.
    const pending = await prisma.historicalExample.findMany({ where: { quality: { not: "VERIFIED" }, source: "HISTORICAL_IMPORT" }, select: { id: true } });
    if (pending.length) {
      const job = await createJob({
        type: "HISTORICAL_PREP",
        createdById: user.id,
        sourceFileId: id,
        fileName: file.fileName,
        items: pending.map((p) => ({ refId: p.id })),
      });
      prepJobId = job.id;
      after(() => triggerProcessing(job.id));
    }
    await audit({
      userId: user.id,
      action: "upload.import",
      entityType: "SourceFile",
      entityId: id,
      metadata: { kind, importedNotes: result.importedNotes, importedExamples: result.importedExamples, invalidRows: result.invalidRows },
    });
    return { result, prepJobId };
  });
}
