/**
 * Seed the local database with SYNTHETIC notes and historical labels for functional
 * smoke tests. No real patient data; no external calls. Also writes CSV fixtures to
 * tests/fixtures for manual upload testing.
 *   npm run seed:synthetic
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db/prisma";
import { sha256 } from "../src/lib/data/normalization";
import { readCsv } from "../src/lib/data/csv-reader";
import { suggestMapping } from "../src/lib/data/column-mapping";
import { importClinicalNotes, importHistorical } from "../src/lib/data/import-service";
import { prepareHistoricalExample } from "../src/lib/validation/historical-prep";
import { SYN_COMP_HEADERS, SYN_NOTE_HEADERS, syntheticComplications, syntheticNotes, toCsv } from "../src/lib/data/synthetic";

async function seed(name: string, csv: string, kind: "CLINICAL_NOTES" | "HISTORICAL_COMPLICATIONS") {
  const buf = Buffer.from(csv, "utf8");
  if (await prisma.sourceFile.findFirst({ where: { sha256: sha256(buf), status: "IMPORTED" } })) {
    console.log(`${name}: already seeded`);
    return;
  }
  const table = readCsv(csv);
  const mapping = suggestMapping(kind, table.headers);
  const sf = await prisma.sourceFile.create({
    data: {
      fileName: name,
      fileType: "csv",
      kind,
      dataClassification: "SYNTHETIC",
      sha256: sha256(buf),
      sizeBytes: buf.length,
      content: buf,
      expectedChunks: 1,
      uploadComplete: true,
      columnMapping: mapping,
    },
  });
  const r = kind === "CLINICAL_NOTES" ? await importClinicalNotes(sf.id, table, mapping) : await importHistorical(sf.id, table, mapping);
  await prisma.sourceFile.update({ where: { id: sf.id }, data: { status: "IMPORTED", importedAt: new Date(), importReport: JSON.parse(JSON.stringify(r)) } });
  console.log(
    `${name}: rows=${r.totalRows} valid=${r.validRows} invalid=${r.invalidRows} duplicate=${r.duplicateRows} notes=${r.importedNotes} examples=${r.importedExamples}`,
  );
}

async function main() {
  const notesCsv = toCsv(SYN_NOTE_HEADERS, syntheticNotes());
  const compCsv = toCsv(SYN_COMP_HEADERS, syntheticComplications());
  const dir = path.join("tests", "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "synthetic-notes.csv"), notesCsv);
  fs.writeFileSync(path.join(dir, "synthetic-complications.csv"), compCsv);
  await seed("synthetic-notes.csv", notesCsv, "CLINICAL_NOTES");
  await seed("synthetic-complications.csv", compCsv, "HISTORICAL_COMPLICATIONS");
  for (const e of await prisma.historicalExample.findMany({ where: { quality: { not: "VERIFIED" } }, select: { id: true } }))
    await prepareHistoricalExample(e.id);
  console.log("Synthetic seed complete.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
