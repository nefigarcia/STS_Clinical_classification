import { prisma } from "@/lib/db/prisma";
import { sha256 } from "@/lib/data/normalization";
import { readCsv } from "@/lib/data/csv-reader";
import { suggestMapping } from "@/lib/data/column-mapping";
import { importClinicalNotes, importHistorical } from "@/lib/data/import-service";
import { SYN_COMP_HEADERS, SYN_NOTE_HEADERS, syntheticComplications, syntheticNotes, toCsv } from "@/lib/data/synthetic";

export async function dbAvailable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "_prisma_migrations" LIMIT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function resetDb() {
  const tables = await prisma.$queryRaw<
    { tablename: string }[]
  >`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
}

export async function makeUser(role: "ADMIN" | "REVIEWER" | "READ_ONLY" = "REVIEWER") {
  return prisma.user.create({ data: { email: `${role.toLowerCase()}-${Math.random().toString(36).slice(2)}@test.local`, role } });
}

export async function importSynthetic(classification: "SYNTHETIC" | "PHI" = "SYNTHETIC") {
  const notesCsv = toCsv(SYN_NOTE_HEADERS, syntheticNotes());
  const compCsv = toCsv(SYN_COMP_HEADERS, syntheticComplications());
  const mk = async (name: string, csv: string, kind: "CLINICAL_NOTES" | "HISTORICAL_COMPLICATIONS") => {
    const buf = Buffer.from(csv);
    const sf = await prisma.sourceFile.create({
      data: {
        fileName: name,
        fileType: "csv",
        kind,
        dataClassification: classification,
        sha256: sha256(buf),
        sizeBytes: buf.length,
        content: buf,
        expectedChunks: 1,
        uploadComplete: true,
      },
    });
    const t = readCsv(csv);
    const m = suggestMapping(kind, t.headers);
    const r = kind === "CLINICAL_NOTES" ? await importClinicalNotes(sf.id, t, m) : await importHistorical(sf.id, t, m);
    await prisma.sourceFile.update({ where: { id: sf.id }, data: { status: "IMPORTED" } });
    return { sourceFile: sf, result: r, table: t, mapping: m };
  };
  const notes = await mk("synthetic-notes.csv", notesCsv, "CLINICAL_NOTES");
  const comps = await mk("synthetic-complications.csv", compCsv, "HISTORICAL_COMPLICATIONS");
  return { notes, comps };
}

/** An approved manual made of TEST FIXTURE rules (made-up codes; not STS content). */
export async function approvedFixtureManual() {
  const buf = Buffer.from("%PDF-1.7 fixture");
  const sf = await prisma.sourceFile.create({
    data: {
      fileName: "fixture.pdf",
      fileType: "pdf",
      kind: "STS_MANUAL",
      dataClassification: "DEIDENTIFIED",
      sha256: sha256(buf),
      sizeBytes: buf.length,
      content: buf,
      expectedChunks: 1,
      uploadComplete: true,
    },
  });
  const mv = await prisma.manualVersion.create({
    data: {
      version: "TEST-FIXTURE",
      fileName: "fixture.pdf",
      sha256: sf.sha256!,
      sourceFileId: sf.id,
      status: "APPROVED",
      isDefault: true,
      identityCheck: { isStsChsdManual: true },
    },
  });
  const mkRule = (code: string, name: string, page: number) =>
    prisma.sTSManualRule.create({
      data: {
        manualVersionId: mv.id,
        manualVersion: mv.version,
        sectionName: "TEST POSTOPERATIVE EVENTS",
        pageNumber: page,
        stsCode: code,
        complicationName: name,
        isComplicationRule: true,
        chunkText: `TEST FIXTURE postoperative complication rule. Code ${code}: ${name}. Pneumothorax chylothorax arrhythmia reintubation chest tube pacing.`,
      },
    });
  const rules = {
    ptx: await mkRule("T100", "Fixture pneumothorax", 10),
    chylo: await mkRule("T200", "Fixture chylothorax", 11),
    arr: await mkRule("T300", "Fixture arrhythmia", 12),
  };
  return { manual: mv, rules };
}
