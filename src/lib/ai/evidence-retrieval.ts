import { prisma, toVectorLiteral } from "@/lib/db/prisma";

export type RetrievedExample = {
  id: string;
  complication: string;
  clinicalEvidence: string;
  stsRuleId: string | null;
};

/**
 * Retrieve clinically similar VERIFIED examples from the active approved library.
 * Leakage controls:
 *  - never the same patient (by MRN) as the encounter being classified,
 *  - never examples assigned to HOLDOUT / INDEPENDENT_TEST cohorts,
 *  - patient identifiers are never used as a similarity signal.
 */
export async function retrieveExamples(opts: {
  excludeMrn: string;
  categories: string[];
  queryEmbedding: number[] | null;
  k: number;
}): Promise<{ examples: RetrievedExample[]; libraryVersion: number | null }> {
  if (opts.k === 0) return { examples: [], libraryVersion: null };
  const lib = await prisma.exampleLibraryVersion.findFirst({ where: { active: true } });
  if (!lib || lib.exampleIds.length === 0) return { examples: [], libraryVersion: lib?.version ?? null };
  const baseWhere = {
    id: { in: lib.exampleIds },
    quality: "VERIFIED" as const,
    libraryStatus: "APPROVED" as const,
    cohort: "DEVELOPMENT" as const,
    mrn: { not: opts.excludeMrn },
    clinicalEvidence: { not: null },
  };
  let ids: string[] = [];
  if (opts.queryEmbedding) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "HistoricalExample"
      WHERE id = ANY(${lib.exampleIds}) AND quality = 'VERIFIED' AND "libraryStatus" = 'APPROVED'
        AND cohort = 'DEVELOPMENT' AND mrn <> ${opts.excludeMrn} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${toVectorLiteral(opts.queryEmbedding)}::vector
      LIMIT ${opts.k}`;
    ids = rows.map((r) => r.id);
  }
  const candidates = await prisma.historicalExample.findMany({ where: baseWhere, take: 200 });
  const lowerCats = opts.categories.map((c) => c.toLowerCase());
  const scored = candidates
    .map((c) => ({
      c,
      s: lowerCats.reduce((acc, cat) => acc + (c.complication.toLowerCase().includes(cat.split(" ")[0]) ? 1 : 0), 0) + (ids.includes(c.id) ? 2 : 0),
    }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.k);
  return {
    examples: scored.map(({ c }) => ({ id: c.id, complication: c.complication, clinicalEvidence: c.clinicalEvidence!.slice(0, 1200), stsRuleId: c.stsRuleId })),
    libraryVersion: lib.version,
  };
}
