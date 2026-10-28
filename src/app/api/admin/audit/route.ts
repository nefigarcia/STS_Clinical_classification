import { prisma } from "@/lib/db/prisma";
import { handle, requireRole } from "@/lib/auth/guard";
import { intParam, searchParams } from "@/lib/api";

export async function GET(req: Request) {
  return handle("GET /api/admin/audit", async () => {
    await requireRole("ADMIN");
    const sp = searchParams(req);
    const page = intParam(sp.get("page"), 1, 1, 10_000);
    const entityType = sp.get("entityType") ?? undefined;
    const entityId = sp.get("entityId") ?? undefined;
    const where = { ...(entityType ? { entityType } : {}), ...(entityId ? { entityId } : {}) };
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { timestamp: "desc" }, skip: (page - 1) * 50, take: 50, include: { user: { select: { email: true } } } }),
      prisma.auditLog.count({ where }),
    ]);
    return { logs, total, page };
  });
}
