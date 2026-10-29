import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { recordDecision } from "@/lib/review/review-service";
import { previewReset, resetClassifications } from "@/lib/admin/reset";
import { createJob } from "@/lib/jobs/runner";
import { dbAvailable, importSynthetic, makeUser, resetDb, approvedFixtureManual } from "./helpers";

const ready = await dbAvailable();

describe.skipIf(!ready)("reset classification data", () => {
  beforeEach(resetDb);

  it("deletes AI results and history but keeps notes, manual, historical labels and the audit log", async () => {
    await importSynthetic();
    await approvedFixtureManual();
    const reviewer = await makeUser("REVIEWER");
    const enc = await prisma.encounter.findFirstOrThrow({ where: { csn: "00500101" }, include: { notes: true } });
    const pred = await prisma.complicationPrediction.create({
      data: {
        encounterId: enc.id,
        predictedComplication: "Pneumothorax",
        classificationStatus: "SUGGESTED",
        evidenceStatus: "supported",
        evidence: { create: [{ clinicalNoteId: enc.notes[0].id, evidenceText: "x", evidenceType: "positive", verified: true }] },
      },
    });
    await recordDecision(pred.id, reviewer, { decision: "APPROVE" });
    const job = await createJob({ type: "CLASSIFICATION", items: [{ encounterId: enc.id }] });
    await prisma.aiCall.create({ data: { jobId: job.id, purpose: "screening", model: "m", durationMs: 1, success: true } });
    await prisma.aiCall.create({ data: { purpose: "manual-embedding", model: "e", durationMs: 1, success: true } });
    await prisma.noteScreenCache.create({ data: { cacheKey: "k", result: { mentions: [] } } });

    // A queued job blocks the reset.
    await expect(resetClassifications({ includeScreeningCache: false, userId: reviewer.id, via: "ui" })).rejects.toThrow(/queued or running/);
    await prisma.processingJob.update({ where: { id: job.id }, data: { processingStatus: "CANCELLED" } });

    expect(await previewReset(false)).toMatchObject({
      predictions: 1,
      reviewDecisions: 1,
      reviewerFeedbackExamples: 1,
      jobs: 1,
      aiCalls: 1,
      screeningCache: null,
    });
    await resetClassifications({ includeScreeningCache: false, userId: reviewer.id, via: "ui" });

    expect(await prisma.complicationPrediction.count()).toBe(0);
    expect(await prisma.reviewDecision.count()).toBe(0);
    expect(await prisma.processingJob.count({ where: { type: "CLASSIFICATION" } })).toBe(0);
    expect(await prisma.aiCall.count()).toBe(1); // manual embedding usage kept
    expect(await prisma.noteScreenCache.count()).toBe(1); // kept unless requested
    expect(await prisma.clinicalNote.count()).toBe(8);
    expect(await prisma.historicalExample.count({ where: { source: "HISTORICAL_IMPORT" } })).toBe(5);
    expect(await prisma.sTSManualRule.count()).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: "admin.reset_classifications", userId: reviewer.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "review." } } })).toBe(1); // history of the audit itself is kept

    await resetClassifications({ includeScreeningCache: true, userId: reviewer.id, via: "ui" });
    expect(await prisma.noteScreenCache.count()).toBe(0);
  });
});
