import { randomUUID } from "node:crypto";
import type { Prisma, SourceFile } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { readStored } from "@/lib/storage";
import { readExcel, type RawTable } from "./excel-reader";
import { readCsv } from "./csv-reader";
import type { ColumnMapping, ImportKind } from "./column-mapping";
import { validateHistorical, validateNotes, type ImportReport } from "./import-validator";
import { matchHistoricalToEncounter } from "./record-matcher";

export async function loadTable(file: Pick<SourceFile, "id" | "fileType">, sheetName?: string | null): Promise<RawTable> {
  const buf = await readStored(file.id);
  if (file.fileType === "csv") return readCsv(buf.toString("utf8"));
  return readExcel(buf, sheetName ?? undefined);
}

export function validateTable(kind: ImportKind, table: RawTable, mapping: ColumnMapping) {
  return kind === "CLINICAL_NOTES" ? validateNotes(table.rows, mapping, table.headers) : validateHistorical(table.rows, mapping, table.headers);
}

export type ImportResult = ImportReport & {
  importedNotes: number;
  alreadyPresentNotes: number;
  importedExamples: number;
  derivedSurgeryDates: number;
};

/** Import a validated clinical-notes file. Invalid and duplicate rows are preserved as SourceRows, never dropped silently. */
export async function importClinicalNotes(sourceFileId: string, table: RawTable, mapping: ColumnMapping): Promise<ImportResult> {
  const { rows, report } = validateNotes(table.rows, mapping, table.headers);
  if (report.missingRequiredColumns.length) throw new Error(`Missing required columns: ${report.missingRequiredColumns.join(", ")}`);
  const usable = rows.filter((r) => r.status === "VALID");

  // Patients and encounters
  const mrns = [...new Set(usable.map((r) => r.mrn!))];
  await prisma.patient.createMany({ data: mrns.map((mrn) => ({ mrn })), skipDuplicates: true });
  const patients = await prisma.patient.findMany({ where: { mrn: { in: mrns } } });
  const patientId = new Map(patients.map((p) => [p.mrn, p.id]));
  const encKeys = [...new Map(usable.map((r) => [`${r.mrn}|${r.csn}`, { mrn: r.mrn!, csn: r.csn! }])).values()];
  await prisma.encounter.createMany({
    data: encKeys.map((e) => ({ patientId: patientId.get(e.mrn)!, csn: e.csn })),
    skipDuplicates: true,
  });
  const encounters = await prisma.encounter.findMany({ where: { patientId: { in: [...patientId.values()] } } });
  const encId = new Map(encounters.map((e) => [`${patients.find((p) => p.id === e.patientId)!.mrn}|${e.csn}`, e.id]));

  // Notes (dedupe on encounter + NOTE_ID + content hash)
  const existing = await prisma.clinicalNote.findMany({
    where: { encounterId: { in: [...encId.values()] } },
    select: { id: true, encounterId: true, noteId: true, contentHash: true },
  });
  const noteKey = (e: string, n: string, h: string) => `${e}|${n}|${h}`;
  const noteIdByKey = new Map(existing.map((n) => [noteKey(n.encounterId, n.noteId, n.contentHash), n.id]));
  const toCreate: Prisma.ClinicalNoteCreateManyInput[] = [];
  let alreadyPresent = 0;
  for (const r of usable) {
    const e = encId.get(`${r.mrn}|${r.csn}`)!;
    const k = noteKey(e, r.noteId!, r.contentHash!);
    if (noteIdByKey.has(k)) {
      alreadyPresent++;
      continue;
    }
    const id = randomUUID();
    noteIdByKey.set(k, id);
    toCreate.push({
      id,
      encounterId: e,
      noteId: r.noteId!,
      noteType: r.noteType,
      dateOfService: r.dateOfService,
      dateOfServiceRaw: r.dateOfServiceRaw || null,
      filedDate: r.filedDate,
      combinedNoteText: r.noteText!,
      contentHash: r.contentHash!,
      sourceFileId,
      sourceFlag: r.flag,
    });
  }
  for (let i = 0; i < toCreate.length; i += 200) {
    await prisma.clinicalNote.createMany({ data: toCreate.slice(i, i + 200) });
  }

  // Source rows: every input row, linked to its note when resolvable.
  const sourceRows: Prisma.SourceRowCreateManyInput[] = rows.map((r) => {
    const e = r.mrn && r.csn ? encId.get(`${r.mrn}|${r.csn}`) : undefined;
    const linked = e && r.noteId && r.contentHash ? noteIdByKey.get(noteKey(e, r.noteId, r.contentHash)) : undefined;
    return {
      sourceFileId,
      rowNumber: r.rowNumber,
      raw: r.raw,
      status: r.status,
      issues: r.issues.length ? (r.issues as unknown as Prisma.InputJsonValue) : undefined,
      clinicalNoteId: r.status === "INVALID" ? null : (linked ?? null),
    };
  });
  for (let i = 0; i < sourceRows.length; i += 500) {
    await prisma.sourceRow.createMany({ data: sourceRows.slice(i, i + 500), skipDuplicates: true });
  }

  const derived = await deriveSurgeryDates([...encId.values()]);
  return { ...report, importedNotes: toCreate.length, alreadyPresentNotes: alreadyPresent, importedExamples: 0, derivedSurgeryDates: derived };
}

/**
 * Derive a provisional surgery date from the earliest operative note. This is flagged
 * DERIVED_FROM_OP_NOTE so reviewers know it is not an authoritative operation date.
 */
export async function deriveSurgeryDates(encounterIds: string[]): Promise<number> {
  let n = 0;
  for (const id of encounterIds) {
    const enc = await prisma.encounter.findUnique({ where: { id } });
    if (!enc || enc.surgeryDateSource === "MANUAL") continue;
    const op = await prisma.clinicalNote.findFirst({
      where: { encounterId: id, dateOfService: { not: null }, noteType: { in: ["Op Note", "Brief Op Note"], mode: "insensitive" } },
      orderBy: { dateOfService: "asc" },
    });
    if (op?.dateOfService) {
      await prisma.encounter.update({ where: { id }, data: { surgeryDate: op.dateOfService, surgeryDateSource: "DERIVED_FROM_OP_NOTE" } });
      n++;
    }
  }
  return n;
}

/** Import historical expected complications. Original labels are preserved verbatim. */
export async function importHistorical(sourceFileId: string, table: RawTable, mapping: ColumnMapping): Promise<ImportResult> {
  const { rows, report } = validateHistorical(table.rows, mapping, table.headers);
  if (report.missingRequiredColumns.length) throw new Error(`Missing required columns: ${report.missingRequiredColumns.join(", ")}`);
  let imported = 0;
  for (const r of rows) {
    if (r.status !== "VALID") continue;
    const encounter = await matchHistoricalToEncounter(r.mrn!, r.csn!);
    await prisma.historicalExample.create({
      data: {
        sourceFileId,
        sourceRowNumber: r.rowNumber,
        source: "HISTORICAL_IMPORT",
        encounterId: encounter?.id ?? null,
        mrn: r.mrn!,
        csn: r.csn!,
        dateOfService: r.dateOfService,
        dateOfServiceRaw: r.dateOfServiceRaw,
        originalLabel: r.complication!,
        complication: r.complication!,
        noteInfo: r.noteInfo,
        keyWords: r.keyWords,
        additionalInfo: r.additionalInfo,
        quality: "PENDING_VERIFICATION",
        qualityReason: encounter ? "Awaiting evidence mapping" : "No matching patient/encounter in imported notes",
      },
    });
    imported++;
  }
  await prisma.sourceRow.createMany({
    data: rows.map((r) => ({
      sourceFileId,
      rowNumber: r.rowNumber,
      raw: r.raw,
      status: r.status,
      issues: r.issues.length ? (r.issues as unknown as Prisma.InputJsonValue) : undefined,
    })),
    skipDuplicates: true,
  });
  return { ...report, importedNotes: 0, alreadyPresentNotes: 0, importedExamples: imported, derivedSurgeryDates: 0 };
}
