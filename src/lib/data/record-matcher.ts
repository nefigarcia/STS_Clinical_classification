import { prisma } from "@/lib/db/prisma";
import { dateKey } from "./normalization";

export async function matchHistoricalToEncounter(mrn: string, csn: string) {
  return prisma.encounter.findFirst({ where: { csn, patient: { mrn } } });
}

/**
 * Candidate notes for a historical label: same encounter and same calendar Date of
 * Service. This identifies *candidates* only; it does not prove evidence.
 */
export async function candidateNotesForDate(encounterId: string, dateOfService: Date | null) {
  const notes = await prisma.clinicalNote.findMany({
    where: { encounterId },
    orderBy: [{ dateOfService: "asc" }, { noteId: "asc" }],
  });
  if (!dateOfService) return { sameDay: [], all: notes };
  const key = dateKey(dateOfService);
  return { sameDay: notes.filter((n) => dateKey(n.dateOfService) === key), all: notes };
}
