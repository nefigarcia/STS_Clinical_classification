import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { parseJson } from "@/lib/api";
import { createJob, triggerProcessing } from "@/lib/jobs/runner";
import { classificationGate, encounterClassification } from "@/lib/security/gates";
import { audit } from "@/lib/audit";

const schema = z.object({ secondOpinion: z.boolean().default(false) });

/** (Re)classify one encounter; secondOpinion=true forces the escalation model (reviewer-requested). */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/classifications/[encounterId]">) {
  return handle("POST /api/classifications/[encounterId]", async () => {
    const user = await requireRole("REVIEWER");
    const { encounterId } = await ctx.params;
    const body = await parseJson(req, schema);
    const enc = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!enc) throw new ApiError(404, "Encounter not found");
    const gate = await classificationGate(await encounterClassification(encounterId));
    if (!gate.allowed) throw new ApiError(409, "AI classification is disabled", { reasons: gate.reasons });
    const job = await createJob({
      type: "CLASSIFICATION",
      createdById: user.id,
      params: { forceEscalation: body.secondOpinion },
      items: [{ encounterId }],
    });
    await audit({
      userId: user.id,
      action: body.secondOpinion ? "classification.second_opinion" : "classification.rerun",
      entityType: "Encounter",
      entityId: encounterId,
      metadata: { jobId: job.id },
    });
    after(() => triggerProcessing(job.id));
    return { jobId: job.id };
  });
}
