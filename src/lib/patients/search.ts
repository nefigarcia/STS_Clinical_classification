import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type SearchFilters = {
  q?: string;
  mrn?: string;
  csn?: string;
  dateOfService?: string; // YYYY-MM-DD
  noteId?: string;
  complication?: string;
  reviewStatus?: string;
  page: number;
  pageSize: number;
  sort: "mrn" | "csn" | "date" | "status";
  dir: "asc" | "desc";
};

export type SearchRow = {
  encounterId: string;
  mrn: string;
  csn: string;
  firstDate: Date | null;
  lastDate: Date | null;
  noteCount: number;
  complications: string | null;
  statuses: string | null;
  pending: number;
};

const like = (s: string) => `%${s.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

/** Encounter-level search with partial identifier matching. Never returns note text. */
export async function searchEncounters(f: SearchFilters) {
  const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (f.q) {
    const q = like(f.q.trim());
    conds.push(
      Prisma.sql`(p.mrn ILIKE ${q} OR e.csn ILIKE ${q} OR EXISTS (SELECT 1 FROM "ClinicalNote" n2 WHERE n2."encounterId" = e.id AND n2."noteId" ILIKE ${q}) OR EXISTS (SELECT 1 FROM "ComplicationPrediction" c2 WHERE c2."encounterId" = e.id AND c2."supersededAt" IS NULL AND (c2."predictedComplication" ILIKE ${q} OR c2."finalComplication" ILIKE ${q})))`,
    );
  }
  if (f.mrn) conds.push(Prisma.sql`p.mrn ILIKE ${like(f.mrn.trim())}`);
  if (f.csn) conds.push(Prisma.sql`e.csn ILIKE ${like(f.csn.trim())}`);
  if (f.noteId) conds.push(Prisma.sql`EXISTS (SELECT 1 FROM "ClinicalNote" n3 WHERE n3."encounterId" = e.id AND n3."noteId" ILIKE ${like(f.noteId.trim())})`);
  if (f.dateOfService && /^\d{4}-\d{2}-\d{2}$/.test(f.dateOfService)) {
    conds.push(Prisma.sql`EXISTS (SELECT 1 FROM "ClinicalNote" n4 WHERE n4."encounterId" = e.id AND n4."dateOfService"::date = ${f.dateOfService}::date)`);
  }
  if (f.complication) {
    conds.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "ComplicationPrediction" c3 WHERE c3."encounterId" = e.id AND c3."supersededAt" IS NULL AND (c3."predictedComplication" ILIKE ${like(f.complication)} OR c3."finalComplication" ILIKE ${like(f.complication)}))`,
    );
  }
  if (f.reviewStatus) {
    if (f.reviewStatus === "UNPROCESSED")
      conds.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "ComplicationPrediction" c4 WHERE c4."encounterId" = e.id AND c4."supersededAt" IS NULL)`);
    else
      conds.push(
        Prisma.sql`EXISTS (SELECT 1 FROM "ComplicationPrediction" c4 WHERE c4."encounterId" = e.id AND c4."supersededAt" IS NULL AND c4."classificationStatus" <> 'EXCLUDED' AND c4."reviewStatus"::text = ${f.reviewStatus})`,
      );
  }
  const where = Prisma.join(conds, " AND ");
  const order =
    f.sort === "csn" ? Prisma.sql`e.csn` : f.sort === "date" ? Prisma.sql`"firstDate"` : f.sort === "status" ? Prisma.sql`pending` : Prisma.sql`p.mrn`;
  const dir = f.dir === "desc" ? Prisma.sql`DESC NULLS LAST` : Prisma.sql`ASC NULLS LAST`;
  const rows = await prisma.$queryRaw<SearchRow[]>`
    SELECT e.id AS "encounterId", p.mrn, e.csn,
      (SELECT min(n."dateOfService") FROM "ClinicalNote" n WHERE n."encounterId" = e.id) AS "firstDate",
      (SELECT max(n."dateOfService") FROM "ClinicalNote" n WHERE n."encounterId" = e.id) AS "lastDate",
      (SELECT count(*)::int FROM "ClinicalNote" n WHERE n."encounterId" = e.id) AS "noteCount",
      (SELECT string_agg(DISTINCT coalesce(c."finalComplication", c."predictedComplication"), '; ') FROM "ComplicationPrediction" c WHERE c."encounterId" = e.id AND c."supersededAt" IS NULL AND c."classificationStatus" <> 'EXCLUDED') AS complications,
      (SELECT string_agg(DISTINCT c."reviewStatus"::text, ',') FROM "ComplicationPrediction" c WHERE c."encounterId" = e.id AND c."supersededAt" IS NULL AND c."classificationStatus" <> 'EXCLUDED') AS statuses,
      (SELECT count(*)::int FROM "ComplicationPrediction" c WHERE c."encounterId" = e.id AND c."supersededAt" IS NULL AND c."classificationStatus" <> 'EXCLUDED' AND c."reviewStatus" IN ('PENDING','NEEDS_REVIEW')) AS pending
    FROM "Encounter" e JOIN "Patient" p ON p.id = e."patientId"
    WHERE ${where}
    ORDER BY ${order} ${dir}, e.id
    LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`;
  const total = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "Encounter" e JOIN "Patient" p ON p.id = e."patientId" WHERE ${where}`;
  return { rows, total: total[0]?.n ?? 0 };
}

/** Ordered neighbours for Previous/Next navigation in the review screen. */
export async function encounterNeighbors(encounterId: string) {
  const all = await prisma.$queryRaw<{ id: string }[]>`
    SELECT e.id FROM "Encounter" e JOIN "Patient" p ON p.id = e."patientId" ORDER BY p.mrn, e.csn, e.id`;
  const i = all.findIndex((r) => r.id === encounterId);
  return { prev: i > 0 ? all[i - 1].id : null, next: i >= 0 && i < all.length - 1 ? all[i + 1].id : null, position: i + 1, total: all.length };
}
