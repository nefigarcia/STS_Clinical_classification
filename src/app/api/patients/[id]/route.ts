import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { parseJson } from "@/lib/api";
import { getEncounterDetail } from "@/lib/patients/encounter-detail";
import { audit } from "@/lib/audit";

/** Encounter detail for review (id = encounter id). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/patients/[id]">) {
  return handle("GET /api/patients/[id]", async () => {
    const user = await requireRole("READ_ONLY");
    const { id } = await ctx.params;
    const detail = await getEncounterDetail(id);
    if (!detail) throw new ApiError(404, "Encounter not found");
    await audit({ userId: user.id, action: "encounter.view", entityType: "Encounter", entityId: id });
    return detail;
  });
}

const patchSchema = z.object({
  surgeryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  admissionDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  dischargeDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

const d = (s: string | null | undefined) => (s === undefined ? undefined : s === null ? null : new Date(`${s}T00:00:00Z`));

/** Reviewer-confirmed encounter dates (surgery date drives STS manual version selection). */
export async function PATCH(req: NextRequest, ctx: RouteContext<"/api/patients/[id]">) {
  return handle("PATCH /api/patients/[id]", async () => {
    const user = await requireRole("REVIEWER");
    const { id } = await ctx.params;
    const body = await parseJson(req, patchSchema);
    await prisma.encounter.update({
      where: { id },
      data: {
        surgeryDate: d(body.surgeryDate),
        surgeryDateSource: body.surgeryDate === undefined ? undefined : body.surgeryDate ? "MANUAL" : "UNKNOWN",
        admissionDate: d(body.admissionDate),
        dischargeDate: d(body.dischargeDate),
      },
    });
    await audit({ userId: user.id, action: "encounter.update_dates", entityType: "Encounter", entityId: id, metadata: { fields: Object.keys(body) } });
    return { ok: true };
  });
}
