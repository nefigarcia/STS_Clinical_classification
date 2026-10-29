import { prisma } from "@/lib/db/prisma";
import { encounterNeighbors } from "./search";

/** Everything the review screen needs except full note text (fetched per note, audited). */
export async function getEncounterDetail(encounterId: string) {
  const enc = await prisma.encounter.findUnique({
    where: { id: encounterId },
    include: {
      patient: true,
      notes: {
        select: { id: true, noteId: true, noteType: true, dateOfService: true, filedDate: true, contentHash: true, sourceFlag: true, combinedNoteText: false },
        orderBy: [{ dateOfService: "asc" }, { noteId: "asc" }],
      },
    },
  });
  if (!enc) return null;
  const predictions = await prisma.complicationPrediction.findMany({
    where: { encounterId, supersededAt: null },
    orderBy: [{ classificationStatus: "asc" }, { createdAt: "asc" }],
    include: {
      evidence: { include: { clinicalNote: { select: { noteId: true, noteType: true, dateOfService: true } } } },
      reviews: { orderBy: { reviewedAt: "desc" }, include: { reviewer: { select: { email: true, name: true } } } },
      manualReference: { select: { id: true, sectionName: true, pageNumber: true, longName: true, shortName: true, stsCode: true, complicationName: true } },
      manualVersion: { select: { version: true } },
    },
  });
  // Similar verified examples (other patients only) for each predicted complication.
  const labels = [...new Set(predictions.map((p) => p.predictedComplication))];
  const examples = labels.length
    ? await prisma.historicalExample.findMany({
        where: {
          quality: "VERIFIED",
          libraryStatus: "APPROVED",
          mrn: { not: enc.patient.mrn },
          OR: labels.map((l) => ({ complication: { contains: l.split(/[\s,]/)[0], mode: "insensitive" as const } })),
        },
        take: 20,
        select: { id: true, complication: true, clinicalEvidence: true },
      })
    : [];
  const [lengths, neighbors, lastRun] = await Promise.all([
    prisma.$queryRaw<{ id: string; len: number }[]>`SELECT id, length("combinedNoteText")::int AS len FROM "ClinicalNote" WHERE "encounterId" = ${encounterId}`,
    encounterNeighbors(encounterId),
    prisma.classificationCache.findFirst({
      where: { encounterId, invalidatedAt: null },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, model: true, manualVersion: true, promptVersion: true },
    }),
  ]);
  const lenById = new Map(lengths.map((l) => [l.id, l.len]));
  return {
    encounter: {
      id: enc.id,
      mrn: enc.patient.mrn,
      csn: enc.csn,
      surgeryDate: enc.surgeryDate,
      surgeryDateSource: enc.surgeryDateSource,
      admissionDate: enc.admissionDate,
      dischargeDate: enc.dischargeDate,
      dischargeDateSource: enc.dischargeDateSource,
      databaseDischargeDate: enc.databaseDischargeDate,
      orExitAt: enc.orExitAt,
    },
    notes: enc.notes.map((n) => ({ ...n, length: lenById.get(n.id) ?? 0 })),
    predictions,
    examples: examples.map((e) => ({ ...e, clinicalEvidence: e.clinicalEvidence?.slice(0, 400) ?? null })),
    neighbors,
    lastRun,
  };
}

export type EncounterDetail = NonNullable<Awaited<ReturnType<typeof getEncounterDetail>>>;
