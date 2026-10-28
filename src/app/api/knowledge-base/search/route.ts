import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { intParam, searchParams } from "@/lib/api";
import { searchRules } from "@/lib/ai/sts-rules";

/** Keyword search over indexed STS rules (manual text only; no patient data, no external calls). */
export async function GET(req: Request) {
  return handle("GET /api/knowledge-base/search", async () => {
    await requireRole("READ_ONLY");
    const sp = searchParams(req);
    const ruleId = sp.get("ruleId");
    if (ruleId) {
      // Unsupported("vector") columns are never selected by Prisma.
      const rule = await prisma.sTSManualRule.findUnique({ where: { id: ruleId } });
      if (!rule) throw new ApiError(404, "Rule not found");
      return { rule };
    }
    const q = (sp.get("q") ?? "").trim();
    const manualVersionId = sp.get("manualVersionId");
    if (!manualVersionId) throw new ApiError(400, "manualVersionId required");
    if (!q) {
      const rules = await prisma.sTSManualRule.findMany({
        where: { manualVersionId, isComplicationRule: true },
        orderBy: { pageNumber: "asc" },
        take: intParam(sp.get("limit"), 50, 1, 200),
        select: { id: true, sectionName: true, pageNumber: true, longName: true, shortName: true, stsCode: true, complicationName: true, chunkText: true },
      });
      return { rules };
    }
    return { rules: await searchRules(manualVersionId, q, null, intParam(sp.get("limit"), 20, 1, 100)) };
  });
}
