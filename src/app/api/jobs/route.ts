import { after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { parseJson } from "@/lib/api";
import { createJob, triggerProcessing } from "@/lib/jobs/runner";
import { classificationGate, encounterClassification, mostRestrictive } from "@/lib/security/gates";
import { modelConfig } from "@/lib/ai/openai-client";
import { audit } from "@/lib/audit";

export async function GET() {
  return handle("GET /api/jobs", async () => {
    await requireRole("READ_ONLY");
    const jobs = await prisma.processingJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        type: true,
        fileName: true,
        processingStatus: true,
        totalRecords: true,
        processedRecords: true,
        failedRecords: true,
        currentModel: true,
        inputTokens: true,
        outputTokens: true,
        cachedTokens: true,
        tokenUsage: true,
        estimatedCost: true,
        actualCost: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        lastTickAt: true,
        errors: true,
      },
    });
    return { jobs };
  });
}

const createSchema = z.object({
  scope: z.enum(["all_unprocessed", "all", "source_file", "encounters"]),
  sourceFileId: z.string().optional(),
  encounterIds: z.array(z.string()).max(5000).optional(),
  forceEscalation: z.boolean().default(false),
});

/** Queue a classification job. Gates (API key, approved manual, PHI approval) are checked up front. */
export async function POST(req: Request) {
  return handle("POST /api/jobs", async () => {
    const user = await requireRole("REVIEWER");
    const body = await parseJson(req, createSchema);
    let encounterIds: string[];
    if (body.scope === "encounters") encounterIds = body.encounterIds ?? [];
    else if (body.scope === "source_file") {
      if (!body.sourceFileId) throw new ApiError(400, "sourceFileId required");
      const rows = await prisma.clinicalNote.findMany({ where: { sourceFileId: body.sourceFileId }, select: { encounterId: true }, distinct: ["encounterId"] });
      encounterIds = rows.map((r) => r.encounterId);
    } else {
      const encs = await prisma.encounter.findMany({
        where: body.scope === "all_unprocessed" ? { cacheEntries: { none: { invalidatedAt: null } }, predictions: { none: { supersededAt: null } } } : {},
        select: { id: true },
      });
      encounterIds = encs.map((e) => e.id);
    }
    if (encounterIds.length === 0) throw new ApiError(400, "No encounters to process");
    const classes = await Promise.all(encounterIds.map((id) => encounterClassification(id)));
    const gate = await classificationGate(mostRestrictive(classes));
    if (!gate.allowed) throw new ApiError(409, "AI classification is disabled", { reasons: gate.reasons });
    const active = await prisma.processingJob.findFirst({ where: { type: "CLASSIFICATION", processingStatus: { in: ["QUEUED", "RUNNING"] } } });
    if (active) throw new ApiError(409, "A classification job is already running; pause or wait for it to finish");
    const job = await createJob({
      type: "CLASSIFICATION",
      createdById: user.id,
      sourceFileId: body.sourceFileId ?? null,
      params: { forceEscalation: body.forceEscalation, primaryModel: modelConfig().primary, escalationModel: modelConfig().escalation },
      items: encounterIds.map((encounterId) => ({ encounterId })),
    });
    await audit({
      userId: user.id,
      action: "job.create",
      entityType: "ProcessingJob",
      entityId: job.id,
      metadata: { type: "CLASSIFICATION", encounters: encounterIds.length },
    });
    after(() => triggerProcessing(job.id));
    return { jobId: job.id, encounters: encounterIds.length };
  });
}
