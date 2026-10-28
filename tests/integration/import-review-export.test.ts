import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { importClinicalNotes } from "@/lib/data/import-service";
import { prepareHistoricalExample } from "@/lib/validation/historical-prep";
import { recordDecision, addMissingComplication } from "@/lib/review/review-service";
import { reviewExample } from "@/lib/review/example-library";
import { complicationLevelRows, noteLevelRows, renderExport } from "@/lib/export/exporter";
import { readCsv } from "@/lib/data/csv-reader";
import { ApiError } from "@/lib/errors";
import { dbAvailable, importSynthetic, makeUser, resetDb, approvedFixtureManual } from "./helpers";

const ready = await dbAvailable();

describe.skipIf(!ready)("import → review → export (database)", () => {
  beforeEach(resetDb);

  it("imports notes preserving identifiers, grouping by encounter and deduplicating", async () => {
    const { notes } = await importSynthetic();
    expect(notes.result.importedNotes).toBe(8);
    const patients = await prisma.patient.findMany({ orderBy: { mrn: "asc" } });
    expect(patients.map((p) => p.mrn)).toEqual(["0001001", "0002002"]);
    const enc = await prisma.encounter.findFirstOrThrow({ where: { csn: "00500101" }, include: { notes: true } });
    expect(enc.notes).toHaveLength(5); // 6 valid rows, one exact duplicate
    expect(enc.notes.map((n) => n.noteId)).toContain("000900001");
    expect(enc.surgeryDateSource).toBe("DERIVED_FROM_OP_NOTE");
    const rows = await prisma.sourceRow.groupBy({ by: ["status"], where: { sourceFileId: notes.sourceFile.id }, _count: true });
    expect(Object.fromEntries(rows.map((r) => [r.status, r._count]))).toEqual({ VALID: 8, INVALID: 2, DUPLICATE: 1 });
  });

  it("is idempotent when the same notes are imported again", async () => {
    const { notes } = await importSynthetic();
    const sf2 = await prisma.sourceFile.create({
      data: { fileName: "again.csv", fileType: "csv", kind: "CLINICAL_NOTES", dataClassification: "SYNTHETIC", sizeBytes: 1, expectedChunks: 1 },
    });
    const r = await importClinicalNotes(sf2.id, notes.table, notes.mapping);
    expect(r.importedNotes).toBe(0);
    expect(r.alreadyPresentNotes).toBe(8);
    expect(await prisma.clinicalNote.count()).toBe(8);
  });

  it("maps historical labels to candidate notes without auto-verifying", async () => {
    await importSynthetic();
    const exs = await prisma.historicalExample.findMany();
    for (const e of exs) await prepareHistoricalExample(e.id);
    const after = await prisma.historicalExample.findMany({ orderBy: { dateOfService: "asc" } });
    expect(after.every((e) => e.quality !== "VERIFIED")).toBe(true);
    expect(after.find((e) => e.originalLabel === "Pneumothorax")!.supportingNoteIds).toEqual(["000900002"]);
    expect(after.find((e) => e.originalLabel === "Pleural effusion")!.quality).toBe("CONFLICTING_EVIDENCE");
    expect(after.find((e) => e.originalLabel === "Arrhythmia, temp pacer")).toBeDefined(); // original value preserved
  });

  it("records append-only review decisions, guards concurrency, audits, and queues candidate examples", async () => {
    await importSynthetic();
    const reviewer = await makeUser("REVIEWER");
    const enc = await prisma.encounter.findFirstOrThrow({ where: { csn: "00500101" }, include: { notes: true } });
    const note = enc.notes.find((n) => n.noteId === "000900002")!;
    const pred = await prisma.complicationPrediction.create({
      data: {
        encounterId: enc.id,
        predictedComplication: "Pneumothorax",
        classificationStatus: "SUGGESTED",
        evidenceStatus: "supported",
        evidence: { create: [{ clinicalNoteId: note.id, evidenceText: "new right pneumothorax", evidenceType: "confirmed", verified: true }] },
      },
    });
    await recordDecision(pred.id, reviewer, { decision: "NEEDS_REVIEW", comments: "check film", expectedStatus: "PENDING" });
    await expect(recordDecision(pred.id, reviewer, { decision: "APPROVE", expectedStatus: "PENDING" })).rejects.toThrow(ApiError);
    await recordDecision(pred.id, reviewer, { decision: "APPROVE", comments: "confirmed", expectedStatus: "NEEDS_REVIEW" });
    const history = await prisma.reviewDecision.findMany({ where: { predictionId: pred.id }, orderBy: { reviewedAt: "asc" } });
    expect(history.map((h) => [h.decision, h.previousStatus])).toEqual([
      ["NEEDS_REVIEW", "PENDING"],
      ["APPROVE", "NEEDS_REVIEW"],
    ]);
    const p = await prisma.complicationPrediction.findUniqueOrThrow({ where: { id: pred.id } });
    expect(p.reviewStatus).toBe("APPROVED");
    expect(p.finalComplication).toBe("Pneumothorax");
    const cand = await prisma.historicalExample.findFirstOrThrow({ where: { predictionId: pred.id } });
    expect(cand).toMatchObject({ source: "REVIEWER_FEEDBACK", libraryStatus: "CANDIDATE", supportingNoteIds: ["000900002"] });
    expect(await prisma.auditLog.count({ where: { entityId: pred.id, action: { startsWith: "review." } } })).toBe(2);

    // Library approval is a separate, explicit step that snapshots a new version.
    const { version } = await reviewExample(cand.id, reviewer, { action: "approve" });
    const lib = await prisma.exampleLibraryVersion.findUniqueOrThrow({ where: { version } });
    expect(lib.active).toBe(true);
    expect(lib.exampleIds).toContain(cand.id);
  });

  it("rejects corrections to STS codes absent from the manual and validates reviewer-added evidence", async () => {
    await importSynthetic();
    await approvedFixtureManual();
    const reviewer = await makeUser("REVIEWER");
    const enc = await prisma.encounter.findFirstOrThrow({ where: { csn: "00500101" }, include: { notes: true } });
    const pred = await prisma.complicationPrediction.create({
      data: { encounterId: enc.id, predictedComplication: "X", classificationStatus: "SUGGESTED", evidenceStatus: "supported" },
    });
    await expect(recordDecision(pred.id, reviewer, { decision: "CORRECT", correctedComplication: "Y", correctedStsCode: "NOT-A-CODE" })).rejects.toThrow(
      /not present/,
    );
    await recordDecision(pred.id, reviewer, { decision: "CORRECT", correctedComplication: "Fixture chylothorax", correctedStsCode: "T200" });
    const note = enc.notes.find((n) => n.noteId === "000900004")!;
    const { predictionId } = await addMissingComplication(enc.id, reviewer, {
      complication: "Fixture chylothorax",
      stsCode: "T200",
      evidence: [{ clinicalNoteId: note.id, excerpt: "consistent with chylothorax" }],
    });
    const added = await prisma.complicationPrediction.findUniqueOrThrow({ where: { id: predictionId }, include: { evidence: true } });
    expect(added.classificationStatus).toBe("REVIEWER_ADDED");
    expect(added.evidence[0].verified).toBe(true);
  });

  it("exports complication-level and note-level data with final decisions distinguished from AI suggestions", async () => {
    await importSynthetic();
    const reviewer = await makeUser("REVIEWER");
    const enc = await prisma.encounter.findFirstOrThrow({ where: { csn: "00500101" }, include: { notes: true } });
    const n2 = enc.notes.find((n) => n.noteId === "000900002")!;
    const n4 = enc.notes.find((n) => n.noteId === "000900004")!;
    const approved = await prisma.complicationPrediction.create({
      data: {
        encounterId: enc.id,
        predictedComplication: "Pneumothorax",
        classificationStatus: "SUGGESTED",
        evidenceStatus: "supported",
        modelVersion: "m1",
        evidence: { create: [{ clinicalNoteId: n2.id, evidenceText: "pneumothorax", evidenceType: "confirmed", verified: true }] },
      },
    });
    await prisma.complicationPrediction.create({
      data: {
        encounterId: enc.id,
        predictedComplication: "Chylothorax",
        stsCode: "T200",
        classificationStatus: "SUGGESTED",
        evidenceStatus: "supported",
        modelVersion: "m1",
        evidence: { create: [{ clinicalNoteId: n4.id, evidenceText: "chylothorax", evidenceType: "confirmed", verified: true }] },
      },
    });
    await recordDecision(approved.id, reviewer, { decision: "APPROVE", comments: "ok" });

    const comp = await complicationLevelRows();
    expect(comp).toHaveLength(2);
    const ptx = comp.find((r) => r["AI Suggested Complication"] === "Pneumothorax")!;
    expect(ptx).toMatchObject({
      MRN: "0001001",
      CSN: "00500101",
      NOTE_ID: "000900002",
      "Final Approved Complication": "Pneumothorax",
      "Review Status": "APPROVED",
      "Reviewer Comments": "ok",
    });
    const chy = comp.find((r) => r["AI Suggested Complication"] === "Chylothorax")!;
    expect(chy["Final Approved Complication"]).toBe("");
    expect(chy["STS Code Is Final"]).toMatch(/^NO/);

    const notes = await noteLevelRows();
    expect(notes).toHaveLength(11); // every original input row, including invalid/duplicate
    const r2 = notes.find((r) => (r as Record<string, string>).NOTE_ID === "000900002") as Record<string, string>;
    expect(r2.MRN).toBe("0001001");
    expect(r2.FINAL_APPROVED_COMPLICATIONS).toBe("Pneumothorax");

    const csv = (await renderExport(comp, "csv")).toString("utf8");
    const parsed = readCsv(csv);
    expect(parsed.rows.find((r) => r["AI Suggested Complication"] === "Pneumothorax")!.MRN).toBe("0001001");
  });
});
