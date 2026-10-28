import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { candidateNotesForDate, matchHistoricalToEncounter } from "@/lib/data/record-matcher";
import { mapHistoricalEvidence } from "@/lib/data/evidence-mapper";

/**
 * Map one historical expected label to candidate evidence (local only — no external AI).
 * Join MRN + CSN + Date of Service -> candidate notes -> keyword/term search with
 * assertion screening. Never marks an example VERIFIED; that is a clinician decision.
 */
export async function prepareHistoricalExample(exampleId: string) {
  const ex = await prisma.historicalExample.findUniqueOrThrow({ where: { id: exampleId } });
  if (ex.quality === "VERIFIED") return { skipped: true as const };
  const encounter = ex.encounterId ? { id: ex.encounterId } : await matchHistoricalToEncounter(ex.mrn, ex.csn);
  if (!encounter) {
    await prisma.historicalExample.update({
      where: { id: ex.id },
      data: { quality: "INSUFFICIENT_EVIDENCE", qualityReason: "No matching patient/encounter (MRN + CSN) among imported notes" },
    });
    return { skipped: false as const, quality: "INSUFFICIENT_EVIDENCE" };
  }
  const { sameDay } = await candidateNotesForDate(encounter.id, ex.dateOfService);
  const outcome = mapHistoricalEvidence(ex.complication, ex.keyWords, ex.noteInfo, sameDay);
  // Rule linkage suggestion (only from an approved manual; never fabricated).
  const manual = await prisma.manualVersion.findFirst({ where: { status: "APPROVED" }, orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }] });
  let stsRuleId: string | null = ex.stsRuleId;
  let labelNote = "";
  if (manual && !stsRuleId) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "STSManualRule"
      WHERE "manualVersionId" = ${manual.id} AND "isComplicationRule" = true
        AND to_tsvector('english', "chunkText") @@ plainto_tsquery('english', ${ex.complication})
      ORDER BY ts_rank_cd(to_tsvector('english', "chunkText"), plainto_tsquery('english', ${ex.complication})) DESC
      LIMIT 1`;
    stsRuleId = rows[0]?.id ?? null;
    if (!stsRuleId) labelNote = " Label not found in the approved STS manual; review label validity.";
  } else if (!manual) {
    labelNote = " STS manual not loaded; label validity against STS not checked.";
  }
  await prisma.historicalExample.update({
    where: { id: ex.id },
    data: {
      encounterId: encounter.id,
      quality: outcome.quality,
      qualityReason: outcome.reason + (labelNote ? `.${labelNote}` : ""),
      candidateNoteIds: outcome.candidateNoteIds,
      supportingNoteIds: outcome.supportingNoteIds,
      clinicalEvidence:
        outcome.candidates
          .filter((c) => c.assertion === "affirmed")
          .slice(0, 4)
          .map((c) => `[NOTE_ID ${c.noteId}${c.noteType ? `, ${c.noteType}` : ""}] ${c.excerpt}`)
          .join("\n---\n") || null,
      stsRuleId,
    },
  });
  await prisma.auditLog.create({
    data: {
      action: "historical.evidence_mapped",
      entityType: "HistoricalExample",
      entityId: ex.id,
      metadata: { quality: outcome.quality, candidates: outcome.candidates.length } as Prisma.InputJsonValue,
    },
  });
  return { skipped: false as const, quality: outcome.quality, candidates: outcome.candidates };
}
