import type { NextRequest } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";

/** Full text of one clinical note (noteId = internal ClinicalNote id). Every access is audited. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/patients/[id]/notes/[noteId]">) {
  return handle("GET /api/patients/[id]/notes/[noteId]", async () => {
    const user = await requireRole("READ_ONLY");
    const { id, noteId } = await ctx.params;
    const note = await prisma.clinicalNote.findFirst({
      where: { id: noteId, encounterId: id },
      select: { id: true, noteId: true, noteType: true, dateOfService: true, filedDate: true, combinedNoteText: true, contentHash: true },
    });
    if (!note) throw new ApiError(404, "Note not found");
    const evidence = await prisma.predictionEvidence.findMany({
      where: { clinicalNoteId: noteId, prediction: { supersededAt: null } },
      select: {
        id: true,
        predictionId: true,
        evidenceStart: true,
        evidenceEnd: true,
        verified: true,
        prediction: { select: { predictedComplication: true, classificationStatus: true } },
      },
    });
    await audit({ userId: user.id, action: "note.view", entityType: "ClinicalNote", entityId: noteId });
    return { note, evidence };
  });
}
