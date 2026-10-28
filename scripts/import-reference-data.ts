/**
 * Import the local reference spreadsheets into the LOCAL database.
 *
 *   npm run import:reference -- [--dir reference-data] [--classification PHI]
 *
 * - Files never leave this machine: no network calls, no AI processing.
 * - Data are classified PHI by default, so the PHI gate blocks external AI processing.
 * - Output is aggregate counts only; identifiers and note text are not printed.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import type { DataClassification } from "@prisma/client";
import { prisma } from "../src/lib/db/prisma";
import { sha256 } from "../src/lib/data/normalization";
import { readExcel } from "../src/lib/data/excel-reader";
import { suggestMapping } from "../src/lib/data/column-mapping";
import { importClinicalNotes, importHistorical } from "../src/lib/data/import-service";
import { prepareHistoricalExample } from "../src/lib/validation/historical-prep";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const dir = arg("dir", process.env.REFERENCE_DATA_DIR ?? "reference-data");
const classification = arg("classification", "PHI") as DataClassification;

async function importFile(file: string, kind: "CLINICAL_NOTES" | "HISTORICAL_COMPLICATIONS", sheet?: string) {
  const buf = fs.readFileSync(file);
  const hash = sha256(buf);
  const existing = await prisma.sourceFile.findFirst({ where: { sha256: hash, status: "IMPORTED" } });
  if (existing) {
    console.log(`${path.basename(file)}: already imported (identical SHA-256), skipping`);
    return;
  }
  const table = await readExcel(buf, sheet);
  const mapping = suggestMapping(kind, table.headers);
  const sf = await prisma.sourceFile.create({
    data: {
      fileName: path.basename(file),
      fileType: "xlsx",
      kind,
      dataClassification: classification,
      sha256: hash,
      sizeBytes: buf.length,
      content: buf,
      expectedChunks: 1,
      uploadComplete: true,
      sheetName: table.sheetName,
      columnMapping: mapping,
    },
  });
  const result = kind === "CLINICAL_NOTES" ? await importClinicalNotes(sf.id, table, mapping) : await importHistorical(sf.id, table, mapping);
  await prisma.sourceFile.update({
    where: { id: sf.id },
    data: { status: "IMPORTED", importedAt: new Date(), importReport: JSON.parse(JSON.stringify(result)) },
  });
  await prisma.auditLog.create({ data: { action: "upload.import_cli", entityType: "SourceFile", entityId: sf.id, metadata: { kind, classification } } });
  console.log(
    `${path.basename(file)} [${table.sheetName}]: rows=${result.totalRows} valid=${result.validRows} invalid=${result.invalidRows} duplicate=${result.duplicateRows} ` +
      `patients=${result.uniquePatients} encounters=${result.uniqueEncounters} newNotes=${result.importedNotes} examples=${result.importedExamples} attention=${result.notesRequiringAttention}`,
  );
}

async function main() {
  const notes = path.join(dir, "SampleNotes.xlsx");
  const comps = path.join(dir, "Complications.xlsx");
  if (!fs.existsSync(notes) && !fs.existsSync(comps)) throw new Error(`No reference spreadsheets found in ${dir}`);
  if (fs.existsSync(notes)) await importFile(notes, "CLINICAL_NOTES", "INTERNAL 2 CSN");
  if (fs.existsSync(comps)) await importFile(comps, "HISTORICAL_COMPLICATIONS");
  // Local evidence mapping for historical labels (keyword/term search only, no external AI).
  const pending = await prisma.historicalExample.findMany({ where: { quality: { not: "VERIFIED" }, source: "HISTORICAL_IMPORT" }, select: { id: true } });
  const tally: Record<string, number> = {};
  for (const p of pending) {
    const r = await prepareHistoricalExample(p.id);
    if (!r.skipped) tally[r.quality] = (tally[r.quality] ?? 0) + 1;
  }
  console.log("Historical evidence mapping:", tally);
  if (!fs.existsSync(path.join(dir, "2026-07_CHSD TM Version 6.23.2.pdf"))) {
    console.log("STS manual PDF not present: STS-based classification remains disabled until an approved manual is indexed.");
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
