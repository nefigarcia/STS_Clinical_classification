import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { parseJson } from "@/lib/api";
import { audit } from "@/lib/audit";

export async function GET() {
  return handle("GET /api/admin/users", async () => {
    await requireRole("ADMIN");
    const users = await prisma.user.findMany({
      orderBy: { email: "asc" },
      select: { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, createdAt: true },
    });
    return { users };
  });
}

const patchSchema = z.object({ id: z.string(), role: z.enum(["ADMIN", "REVIEWER", "READ_ONLY"]).optional(), active: z.boolean().optional() });

export async function PATCH(req: Request) {
  return handle("PATCH /api/admin/users", async () => {
    const admin = await requireRole("ADMIN");
    const body = await parseJson(req, patchSchema);
    if (body.id === admin.id && ((body.role !== undefined && body.role !== "ADMIN") || body.active === false)) {
      throw new ApiError(400, "Administrators cannot demote or deactivate themselves");
    }
    const user = await prisma.user.update({ where: { id: body.id }, data: { role: body.role, active: body.active } });
    await audit({
      userId: admin.id,
      action: "user.update",
      entityType: "User",
      entityId: user.id,
      metadata: { role: body.role ?? null, active: body.active ?? null },
    });
    return { ok: true };
  });
}
