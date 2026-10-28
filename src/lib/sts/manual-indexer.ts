import type { Prisma } from "@prisma/client";
import { prisma, toVectorLiteral } from "@/lib/db/prisma";
import { readStored } from "@/lib/storage";
import { env } from "@/lib/env";
import { embedTexts } from "@/lib/ai/embeddings";
import { modelConfig } from "@/lib/ai/openai-client";
import { extractPdfPages, checkManualIdentity } from "./pdf-parser";
import { parseManual } from "./rule-parser";

export const EMBED_BATCH = 192;

/**
 * Parse an uploaded manual into semantic rule chunks. Re-running replaces this version's rules.
 * Returns how many rules need embeddings (0 when no OpenAI key is configured: keyword search only).
 */
export async function parseAndStoreManual(manualVersionId: string): Promise<{ rules: number; toEmbed: number; pageCount: number }> {
  const mv = await prisma.manualVersion.findUniqueOrThrow({ where: { id: manualVersionId } });
  await prisma.manualVersion.update({ where: { id: mv.id }, data: { status: "INDEXING" } });
  const buf = await readStored(mv.sourceFileId);
  const { totalPages, pages } = await extractPdfPages(buf);
  const identity = checkManualIdentity(pages);
  if (!identity.isStsChsdManual) {
    await prisma.manualVersion.update({
      where: { id: mv.id },
      data: { status: "REJECTED", pageCount: totalPages, identityCheck: identity as unknown as Prisma.InputJsonValue },
    });
    throw new Error(`Rejected: ${identity.reason}`);
  }
  const parsed = parseManual(pages);
  await prisma.sTSManualRule.deleteMany({ where: { manualVersionId: mv.id } });
  for (let i = 0; i < parsed.length; i += 500) {
    await prisma.sTSManualRule.createMany({
      data: parsed.slice(i, i + 500).map((r) => ({
        manualVersionId: mv.id,
        manualVersion: mv.version,
        sectionName: r.sectionName,
        pageNumber: r.pageNumber,
        pageEnd: r.pageEnd,
        longName: r.longName,
        shortName: r.shortName,
        seqNumber: r.seqNumber,
        dbTable: r.dbTable,
        stsCode: r.stsCode,
        complicationName: r.complicationName,
        definition: r.definition,
        intentClarification: r.intentClarification,
        codingInstructions: r.codingInstructions,
        validCodes: r.validCodes.length ? r.validCodes : undefined,
        parentConditions: r.parentConditions,
        inclusionExclusion: r.inclusionExclusion,
        specialNotes: r.specialNotes,
        chunkText: r.chunkText,
        isComplicationRule: r.isComplicationRule,
      })),
    });
  }
  const willEmbed = Boolean(env().OPENAI_API_KEY);
  await prisma.manualVersion.update({
    where: { id: mv.id },
    data: {
      pageCount: totalPages,
      detectedVersion: identity.detectedVersion,
      identityCheck: identity as unknown as Prisma.InputJsonValue,
      status: willEmbed ? "INDEXING" : "INDEXED",
      embeddingModel: null,
    },
  });
  return { rules: parsed.length, toEmbed: willEmbed ? parsed.length : 0, pageCount: totalPages };
}

/**
 * Embed one batch of rules (manual text only — no patient data). Embedding happens once
 * per manual version; the full PDF is never re-sent per patient.
 */
export async function embedRuleBatch(manualVersionId: string, jobId: string | null): Promise<number> {
  const rules = await prisma.$queryRaw<{ id: string; chunkText: string }[]>`
    SELECT id, "chunkText" FROM "STSManualRule"
    WHERE "manualVersionId" = ${manualVersionId} AND embedding IS NULL
    ORDER BY "pageNumber" LIMIT ${EMBED_BATCH}`;
  if (rules.length === 0) return 0;
  const vectors = await embedTexts(
    rules.map((r) => r.chunkText),
    { purpose: "manual-embedding", jobId },
  );
  for (let i = 0; i < rules.length; i++) {
    await prisma.$executeRaw`UPDATE "STSManualRule" SET embedding = ${toVectorLiteral(vectors[i])}::vector WHERE id = ${rules[i].id}`;
  }
  return rules.length;
}

export async function finishIndexing(manualVersionId: string) {
  const remaining = await prisma.$queryRaw<
    { n: bigint }[]
  >`SELECT count(*) AS n FROM "STSManualRule" WHERE "manualVersionId" = ${manualVersionId} AND embedding IS NULL`;
  const n = Number(remaining[0]?.n ?? 0);
  await prisma.manualVersion.update({
    where: { id: manualVersionId },
    data: { status: "INDEXED", embeddingModel: n === 0 && env().OPENAI_API_KEY ? modelConfig().embedding : null },
  });
}

export async function manualStats(manualVersionId: string) {
  const [total, complication, coded, embedded, withDefinition] = await Promise.all([
    prisma.sTSManualRule.count({ where: { manualVersionId } }),
    prisma.sTSManualRule.count({ where: { manualVersionId, isComplicationRule: true } }),
    prisma.sTSManualRule.count({ where: { manualVersionId, stsCode: { not: null } } }),
    prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "STSManualRule" WHERE "manualVersionId" = ${manualVersionId} AND embedding IS NOT NULL`,
    prisma.sTSManualRule.count({ where: { manualVersionId, definition: { not: null } } }),
  ]);
  return { total, complication, coded, embedded: Number(embedded[0]?.n ?? 0), withDefinition };
}
