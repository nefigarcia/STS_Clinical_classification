import { z } from "zod";
import type { Prisma, ReviewDecisionType, ReviewStatus, User } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { audit } from "@/lib/audit";
import { allowedCodes } from "@/lib/sts/code-validator";
import { ApiError } from "@/lib/errors";

export const decisionSchema = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "CORRECT", "NEEDS_REVIEW"]),
    correctedComplication: z.string().trim().min(2).max(300).optional().nullable(),
    correctedStsCode: z.string().trim().max(20).optional().nullable(),
    comments: z.string().trim().max(4000).optional().nullable(),
    /** Optimistic concurrency: the status the reviewer saw. */
    expectedStatus: z.enum(["PENDING", "APPROVED", "REJECTED", "CORRECTED", "NEEDS_REVIEW"]).optional(),
  })
  .refine((d) => d.decision !== "CORRECT" || Boolean(d.correctedComplication), {
    message: "A corrected complication is required",
    path: ["correctedComplication"],
  });

export const addMissingSchema = z.object({
  complication: z.string().trim().min(2).max(300),
  stsCode: z.string().trim().max(20).optional().nullable(),
  comments: z.string().trim().max(4000).optional().nullable(),
  eventDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  evidence: z
    .array(z.object({ clinicalNoteId: z.string(), excerpt: z.string().trim().min(4).max(2000) }))
    .max(10)
    .default([]),
});

const STATUS_FOR: Record<Exclude<ReviewDecisionType, "ADD_MISSING">, ReviewStatus> = {
  APPROVE: "APPROVED",
  REJECT: "REJECTED",
  CORRECT: "CORRECTED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
};

async function assertCode(manualVersionId: string | null, code: string | null | undefined) {
  if (!code) return;
  const manual =
    manualVersionId ??
    (await prisma.manualVersion.findFirst({ where: { status: "APPROVED", isDefault: true } }))?.id ??
    (await prisma.manualVersion.findFirst({ where: { status: "APPROVED" } }))?.id;
  if (!manual) throw new ApiError(400, "Cannot assign an STS code: no approved STS manual is loaded");
  if (!(await allowedCodes(manual)).has(code)) throw new ApiError(400, `STS code "${code}" is not present in the indexed manual`);
}

/**
 * Record a reviewer decision. Decisions are append-only; the prediction mirrors the latest.
 * Approved/corrected cases enter the candidate example queue (not the verified library).
 */
export async function recordDecision(predictionId: string, user: User, input: z.infer<typeof decisionSchema>) {
  const pred = await prisma.complicationPrediction.findUnique({
    where: { id: predictionId },
    include: { evidence: { include: { clinicalNote: true } }, encounter: { include: { patient: true } } },
  });
  if (!pred) throw new ApiError(404, "Prediction not found");
  if (pred.supersededAt) throw new ApiError(409, "This prediction was superseded by a newer AI run; refresh the encounter");
  if (input.expectedStatus && input.expectedStatus !== pred.reviewStatus) {
    throw new ApiError(409, `Prediction status changed to ${pred.reviewStatus} by another reviewer; reload before deciding`);
  }
  if (input.decision === "CORRECT") await assertCode(pred.manualVersionId, input.correctedStsCode);
  const newStatus = STATUS_FOR[input.decision];
  const finalComplication = input.decision === "APPROVE" ? pred.predictedComplication : input.decision === "CORRECT" ? input.correctedComplication! : null;
  const finalStsCode = input.decision === "APPROVE" ? pred.stsCode : input.decision === "CORRECT" ? (input.correctedStsCode ?? null) : null;

  return prisma.$transaction(async (tx) => {
    const decision = await tx.reviewDecision.create({
      data: {
        predictionId,
        reviewerId: user.id,
        decision: input.decision,
        previousStatus: pred.reviewStatus,
        correctedComplication: input.correctedComplication ?? null,
        correctedStsCode: input.correctedStsCode ?? null,
        comments: input.comments ?? null,
      },
    });
    await tx.complicationPrediction.update({
      where: { id: predictionId },
      data: { reviewStatus: newStatus, finalComplication, finalStsCode },
    });
    if (newStatus === "APPROVED" || newStatus === "CORRECTED") {
      const existing = await tx.historicalExample.findFirst({ where: { predictionId, source: "REVIEWER_FEEDBACK" } });
      const data = {
        complication: finalComplication!,
        originalLabel: finalComplication!,
        clinicalEvidence:
          pred.evidence
            .filter((e) => e.verified)
            .map((e) => e.evidenceText)
            .join("\n---\n") || pred.clinicalEvidence,
        supportingNoteIds: [...new Set(pred.evidence.map((e) => e.clinicalNote.noteId))],
        stsRuleId: pred.manualReferenceId,
        reviewerId: user.id,
        reviewedAt: new Date(),
      };
      if (existing) {
        await tx.historicalExample.update({
          where: { id: existing.id },
          data: { ...data, libraryStatus: existing.libraryStatus === "APPROVED" ? "CANDIDATE" : existing.libraryStatus, quality: "PENDING_VERIFICATION" },
        });
      } else {
        await tx.historicalExample.create({
          data: {
            ...data,
            source: "REVIEWER_FEEDBACK",
            encounterId: pred.encounterId,
            predictionId,
            mrn: pred.encounter.patient.mrn,
            csn: pred.encounter.csn,
            dateOfService: pred.complicationEventDate,
            quality: "PENDING_VERIFICATION",
            qualityReason: `Reviewer ${input.decision === "CORRECT" ? "corrected" : "approved"} AI prediction; awaiting library approval`,
            libraryStatus: "CANDIDATE",
          },
        });
      }
    } else {
      // A later rejection removes any candidate example derived from this prediction.
      await tx.historicalExample.updateMany({
        where: { predictionId, source: "REVIEWER_FEEDBACK", libraryStatus: "CANDIDATE" },
        data: { libraryStatus: "RETIRED" },
      });
    }
    await audit(
      {
        userId: user.id,
        action: `review.${input.decision.toLowerCase()}`,
        entityType: "ComplicationPrediction",
        entityId: predictionId,
        metadata: { decisionId: decision.id, previousStatus: pred.reviewStatus, newStatus, hasComments: Boolean(input.comments) } as Prisma.InputJsonValue,
      },
      tx,
    );
    return { decisionId: decision.id, reviewStatus: newStatus };
  });
}

/** Reviewer adds a complication the AI missed. Evidence excerpts must exist verbatim in the cited note. */
export async function addMissingComplication(encounterId: string, user: User, input: z.infer<typeof addMissingSchema>) {
  const encounter = await prisma.encounter.findUnique({ where: { id: encounterId }, include: { notes: { select: { id: true, combinedNoteText: true } } } });
  if (!encounter) throw new ApiError(404, "Encounter not found");
  await assertCode(null, input.stsCode);
  const evidence = input.evidence.map((e) => {
    const note = encounter.notes.find((n) => n.id === e.clinicalNoteId);
    if (!note) throw new ApiError(400, "Evidence note does not belong to this encounter");
    const idx = note.combinedNoteText.indexOf(e.excerpt);
    return {
      clinicalNoteId: note.id,
      evidenceText: e.excerpt,
      evidenceStart: idx >= 0 ? idx : null,
      evidenceEnd: idx >= 0 ? idx + e.excerpt.length : null,
      evidenceType: "reviewer",
      verified: idx >= 0,
    };
  });
  return prisma.$transaction(async (tx) => {
    const pred = await tx.complicationPrediction.create({
      data: {
        encounterId,
        predictedComplication: input.complication,
        stsCode: input.stsCode ?? null,
        complicationEventDate: input.eventDate ? new Date(`${input.eventDate}T00:00:00Z`) : null,
        classificationStatus: "REVIEWER_ADDED",
        evidenceStatus: evidence.length ? "supported" : "insufficient",
        reviewStatus: "APPROVED",
        finalComplication: input.complication,
        finalStsCode: input.stsCode ?? null,
        clinicalEvidence: evidence.map((e) => e.evidenceText).join("\n---\n") || null,
        aiExplanation: null,
        modelVersion: "reviewer",
        evidence: { create: evidence },
      },
    });
    const decision = await tx.reviewDecision.create({
      data: {
        predictionId: pred.id,
        reviewerId: user.id,
        decision: "ADD_MISSING",
        previousStatus: "PENDING",
        correctedComplication: input.complication,
        correctedStsCode: input.stsCode ?? null,
        comments: input.comments ?? null,
      },
    });
    await audit(
      {
        userId: user.id,
        action: "review.add_missing",
        entityType: "ComplicationPrediction",
        entityId: pred.id,
        metadata: { decisionId: decision.id, encounterId },
      },
      tx,
    );
    return { predictionId: pred.id };
  });
}
