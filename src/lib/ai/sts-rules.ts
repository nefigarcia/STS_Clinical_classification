import { prisma, toVectorLiteral } from "@/lib/db/prisma";

export type RetrievedRule = {
  id: string;
  manualVersion: string;
  sectionName: string | null;
  pageNumber: number;
  longName: string | null;
  shortName: string | null;
  stsCode: string | null;
  complicationName: string | null;
  chunkText: string;
  score: number;
};

type Row = Omit<RetrievedRule, "score"> & { rank: number };

/**
 * Hybrid retrieval: Postgres full-text rank + pgvector cosine similarity, merged with
 * reciprocal-rank fusion. Only rules from the given manual version are returned.
 */
export async function searchRules(
  manualVersionId: string,
  query: string,
  queryEmbedding: number[] | null,
  k = 8,
  opts: { complicationOnly?: boolean } = {},
): Promise<RetrievedRule[]> {
  const complicationOnly = opts.complicationOnly ?? false;
  // OR across terms, ranked by coverage: an AND query would miss rules that use only some of the terms.
  const orQuery = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].join(" or ");
  if (!orQuery && !queryEmbedding) return [];
  const keyword = orQuery
    ? await prisma.$queryRaw<Row[]>`
    SELECT id, "manualVersion", "sectionName", "pageNumber", "longName", "shortName", "stsCode", "complicationName", "chunkText",
           ts_rank_cd(to_tsvector('english', "chunkText"), websearch_to_tsquery('english', ${orQuery})) AS rank
    FROM "STSManualRule"
    WHERE "manualVersionId" = ${manualVersionId}
      AND (${complicationOnly} = false OR "isComplicationRule" = true)
      AND to_tsvector('english', "chunkText") @@ websearch_to_tsquery('english', ${orQuery})
    ORDER BY rank DESC
    LIMIT ${k * 3}`
    : [];
  let semantic: Row[] = [];
  if (queryEmbedding) {
    const vec = toVectorLiteral(queryEmbedding);
    semantic = await prisma.$queryRaw<Row[]>`
      SELECT id, "manualVersion", "sectionName", "pageNumber", "longName", "shortName", "stsCode", "complicationName", "chunkText",
             1 - (embedding <=> ${vec}::vector) AS rank
      FROM "STSManualRule"
      WHERE "manualVersionId" = ${manualVersionId} AND embedding IS NOT NULL
        AND (${complicationOnly} = false OR "isComplicationRule" = true)
      ORDER BY embedding <=> ${vec}::vector
      LIMIT ${k * 3}`;
  }
  const fused = new Map<string, RetrievedRule>();
  const add = (rows: Row[]) =>
    rows.forEach((r, i) => {
      const prev = fused.get(r.id);
      const rrf = 1 / (60 + i);
      if (prev) prev.score += rrf;
      else {
        const { rank: _rank, ...rest } = r;
        fused.set(r.id, { ...rest, score: rrf });
      }
    });
  add(keyword);
  add(semantic);
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

/** Pick the manual version for an encounter based on surgery date and administrator configuration. */
export async function selectManualVersion(surgeryDate: Date | null, surgeryDateSource: string) {
  const approved = await prisma.manualVersion.findMany({ where: { status: "APPROVED" }, orderBy: { createdAt: "desc" } });
  if (approved.length === 0) return null;
  if (surgeryDate && surgeryDateSource !== "UNKNOWN") {
    const match = approved.find(
      (m) => (!m.effectiveFrom || m.effectiveFrom <= surgeryDate) && (!m.effectiveTo || surgeryDate < m.effectiveTo) && (m.effectiveFrom || m.effectiveTo),
    );
    if (match) return { manual: match, selection: surgeryDateSource === "MANUAL" ? "surgery-date" : "derived-surgery-date" } as const;
  }
  const fallback = approved.find((m) => m.isDefault) ?? approved[0];
  return { manual: fallback, selection: surgeryDate ? "default-no-effective-window-match" : "default-no-surgery-date" } as const;
}
