import { prisma } from "@/lib/db/prisma";

export type AllowedCode = { code: string; name: string; ruleId: string; page: number; section: string | null };

/** All STS codes present in the indexed manual version. Codes absent from the manual are never accepted. */
export async function allowedCodes(manualVersionId: string): Promise<Map<string, AllowedCode>> {
  const rules = await prisma.sTSManualRule.findMany({
    where: { manualVersionId, stsCode: { not: null } },
    select: { id: true, stsCode: true, complicationName: true, pageNumber: true, sectionName: true },
  });
  const map = new Map<string, AllowedCode>();
  for (const r of rules) {
    if (!map.has(r.stsCode!)) {
      map.set(r.stsCode!, { code: r.stsCode!, name: r.complicationName ?? "", ruleId: r.id, page: r.pageNumber, section: r.sectionName });
    }
  }
  return map;
}

export function isCodeAllowed(code: string | null, allowed: Map<string, AllowedCode>): boolean {
  return code === null || allowed.has(code);
}
