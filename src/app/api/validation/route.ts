import { after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { parseJson, searchParams } from "@/lib/api";
import { historicalComparison } from "@/lib/validation/historical-comparison";
import { assignCohortsByPatient, reviewExample } from "@/lib/review/example-library";
import { createJob, triggerProcessing } from "@/lib/jobs/runner";
import { classificationGate, encounterClassification, mostRestrictive } from "@/lib/security/gates";
import { modelConfig } from "@/lib/ai/openai-client";
import { audit } from "@/lib/audit";

const COHORTS = ["DEVELOPMENT", "HOLDOUT", "INDEPENDENT_TEST"] as const;

export async function GET(req: Request) {
  return handle("GET /api/validation", async () => {
    await requireRole("READ_ONLY");
    const cohort = COHORTS.find((c) => c === searchParams(req).get("cohort"));
    const comparison = await historicalComparison(cohort);
    const examples = await prisma.historicalExample.findMany({
      orderBy: [{ source: "asc" }, { mrn: "asc" }, { dateOfService: "asc" }],
      select: {
        id: true,
        source: true,
        mrn: true,
        csn: true,
        dateOfService: true,
        originalLabel: true,
        complication: true,
        noteInfo: true,
        keyWords: true,
        additionalInfo: true,
        quality: true,
        qualityReason: true,
        libraryStatus: true,
        cohort: true,
        supportingNoteIds: true,
        candidateNoteIds: true,
        clinicalEvidence: true,
        encounterId: true,
        reviewedAt: true,
        stsRule: { select: { pageNumber: true, sectionName: true, manualVersion: true } },
      },
    });
    const runs = await prisma.evaluationRun.findMany({ orderBy: { createdAt: "desc" }, take: 20, omit: { results: true } });
    return { comparison: { metrics: comparison.metrics, rows: comparison.rows, patients: comparison.patients, examples: comparison.examples }, examples, runs };
  });
}

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("map_evidence") }),
  z.object({
    action: z.literal("review_example"),
    id: z.string(),
    decision: z.enum(["approve", "reject", "conflicting", "insufficient"]),
    cohort: z.enum(COHORTS).optional(),
    comment: z.string().max(1000).nullable().optional(),
  }),
  z.object({ action: z.literal("assign_cohorts"), holdoutMrns: z.array(z.string()).max(1000) }),
  z.object({ action: z.literal("run_evaluation"), model: z.enum(["primary", "escalation"]), cohort: z.enum(COHORTS), name: z.string().max(120).optional() }),
]);

export async function POST(req: Request) {
  return handle("POST /api/validation", async () => {
    const body = await parseJson(req, postSchema);
    if (body.action === "map_evidence") {
      const user = await requireRole("REVIEWER");
      const pending = await prisma.historicalExample.findMany({ where: { quality: { not: "VERIFIED" }, source: "HISTORICAL_IMPORT" }, select: { id: true } });
      if (!pending.length) throw new ApiError(400, "No historical examples awaiting evidence mapping");
      const job = await createJob({ type: "HISTORICAL_PREP", createdById: user.id, items: pending.map((p) => ({ refId: p.id })) });
      after(() => triggerProcessing(job.id));
      return { jobId: job.id };
    }
    if (body.action === "review_example") {
      const user = await requireRole("REVIEWER");
      return reviewExample(body.id, user, { action: body.decision, cohort: body.cohort, comment: body.comment });
    }
    if (body.action === "assign_cohorts") {
      const user = await requireRole("ADMIN");
      await assignCohortsByPatient(body.holdoutMrns, user);
      return { ok: true };
    }
    // Model comparison on held-out labels. Held-out labels are never retrievable as examples.
    const user = await requireRole("ADMIN");
    const encs = await prisma.historicalExample.findMany({
      where: { cohort: body.cohort, encounterId: { not: null }, source: "HISTORICAL_IMPORT" },
      select: { encounterId: true },
      distinct: ["encounterId"],
    });
    const encounterIds = encs.map((e) => e.encounterId!);
    if (!encounterIds.length) throw new ApiError(400, `No encounters with labels in cohort ${body.cohort}`);
    const gate = await classificationGate(mostRestrictive(await Promise.all(encounterIds.map(encounterClassification))));
    if (!gate.allowed) throw new ApiError(409, "AI evaluation is disabled", { reasons: gate.reasons });
    const model = body.model === "primary" ? modelConfig().primary : modelConfig().escalation;
    const lib = await prisma.exampleLibraryVersion.findFirst({ where: { active: true } });
    const prompt = await prisma.promptVersion.findFirst({ where: { active: true } });
    const run = await prisma.evaluationRun.create({
      data: {
        name: body.name ?? `${model} on ${body.cohort}`,
        model,
        cohort: body.cohort,
        libraryVersion: lib?.version ?? null,
        promptVersion: prompt?.version ?? null,
        createdById: user.id,
        results: [],
      },
    });
    const job = await createJob({
      type: "EVALUATION",
      createdById: user.id,
      params: { model, evaluationRunId: run.id },
      items: encounterIds.map((encounterId) => ({ encounterId })),
    });
    await prisma.evaluationRun.update({ where: { id: run.id }, data: { jobId: job.id } });
    await audit({
      userId: user.id,
      action: "evaluation.start",
      entityType: "EvaluationRun",
      entityId: run.id,
      metadata: { model, cohort: body.cohort, encounters: encounterIds.length },
    });
    after(() => triggerProcessing(job.id));
    return { evaluationRunId: run.id, jobId: job.id };
  });
}
