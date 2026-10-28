/**
 * Re-run local evidence mapping for historical labels and print a PHI-free summary.
 *   npm run validate:historical
 * No external services are called.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db/prisma";
import { prepareHistoricalExample } from "../src/lib/validation/historical-prep";

async function main() {
  const examples = await prisma.historicalExample.findMany({ where: { source: "HISTORICAL_IMPORT" }, select: { id: true, originalLabel: true } });
  const rows: { label: string; quality: string; candidates: number }[] = [];
  for (const e of examples) {
    const r = await prepareHistoricalExample(e.id);
    const ex = await prisma.historicalExample.findUniqueOrThrow({ where: { id: e.id }, select: { quality: true, candidateNoteIds: true } });
    rows.push({ label: e.originalLabel, quality: r.skipped ? "VERIFIED (unchanged)" : ex.quality, candidates: ex.candidateNoteIds.length });
  }
  console.table(rows);
  const verified = rows.filter((r) => r.quality.startsWith("VERIFIED")).length;
  console.log(`${verified}/${rows.length} examples verified by a clinician. Only VERIFIED examples are used as few-shot examples.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
