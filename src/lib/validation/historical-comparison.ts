import type { EvaluationCohort } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getSetting } from "@/lib/settings";
import { computeMetrics, type EncounterLabels } from "./metrics";

const ACTIVE = ["SUGGESTED", "SUSPECTED", "CONFLICTING_EVIDENCE"] as const;

/** Compare current (non-superseded) AI predictions with historical expected labels. */
export async function historicalComparison(cohort?: EvaluationCohort) {
  const examples = await prisma.historicalExample.findMany({
    where: { source: "HISTORICAL_IMPORT", ...(cohort ? { cohort } : {}) },
    orderBy: [{ mrn: "asc" }, { csn: "asc" }, { dateOfService: "asc" }],
  });
  const byEncounter = new Map<string, typeof examples>();
  for (const e of examples) {
    const k = e.encounterId ?? `unmatched:${e.mrn}|${e.csn}`;
    (byEncounter.get(k) ?? byEncounter.set(k, []).get(k)!).push(e);
  }
  const data: EncounterLabels[] = [];
  for (const [key, exs] of byEncounter) {
    const encounterId = key.startsWith("unmatched:") ? null : key;
    const preds = encounterId
      ? await prisma.complicationPrediction.findMany({
          where: { encounterId, supersededAt: null, classificationStatus: { in: [...ACTIVE] } },
          include: { evidence: { include: { clinicalNote: { select: { noteId: true } } } } },
        })
      : [];
    const processed = encounterId ? (await prisma.classificationCache.count({ where: { encounterId, invalidatedAt: null } })) > 0 || preds.length > 0 : false;
    data.push({
      encounterId: encounterId ?? key,
      mrn: exs[0].mrn,
      csn: exs[0].csn,
      date: exs[0].dateOfService ? exs[0].dateOfService.toISOString().slice(0, 10) : null,
      expected: exs.map((e) => e.originalLabel),
      expectedSupportingNoteIds: exs.filter((e) => e.quality === "VERIFIED").flatMap((e) => e.supportingNoteIds),
      predicted: preds.map((p) => ({
        label: p.predictedComplication,
        uncertain: p.classificationStatus !== "SUGGESTED" || p.reviewStatus === "NEEDS_REVIEW",
        evidenceVerified: p.evidence.length ? p.evidence.every((e) => e.verified) : false,
        evidenceNoteIds: p.evidence.map((e) => e.clinicalNote.noteId),
      })),
      processed,
    });
  }
  const labelMap = await getSetting("labelMap");
  const patients = new Set(examples.map((e) => e.mrn)).size;
  return { ...computeMetrics(data, labelMap), patients, examples: examples.length, data };
}
