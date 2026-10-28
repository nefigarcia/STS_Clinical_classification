import Papa from "papaparse";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db/prisma";

export type ExportLevel = "complication" | "note";
export type ExportFormat = "csv" | "xlsx";

const FINAL = new Set(["APPROVED", "CORRECTED"]);

export function exportFileName(level: ExportLevel, format: ExportFormat, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `OutputComplication_${stamp}${level === "note" ? "_NoteLevel" : ""}.${format}`;
}

/** Neutralize spreadsheet formula injection without altering ordinary clinical text. */
export function safeCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /^[=+@\t\r]/.test(s) ? `'${s}` : s;
}

function manualRef(p: { manualVersion?: { version: string } | null; manualSection: string | null; manualPage: number | null }) {
  if (!p.manualVersion) return "";
  return `STS CHSD TM ${p.manualVersion.version}${p.manualSection ? ` — ${p.manualSection}` : ""}${p.manualPage ? `, p.${p.manualPage}` : ""}`;
}

type Filters = { encounterIds?: string[]; reviewStatus?: string[] };

async function loadPredictions(f: Filters) {
  return prisma.complicationPrediction.findMany({
    where: {
      supersededAt: null,
      classificationStatus: { not: "EXCLUDED" },
      ...(f.encounterIds?.length ? { encounterId: { in: f.encounterIds } } : {}),
      ...(f.reviewStatus?.length ? { reviewStatus: { in: f.reviewStatus as never[] } } : {}),
    },
    include: {
      encounter: { include: { patient: true } },
      evidence: { include: { clinicalNote: { select: { noteId: true, dateOfService: true } } } },
      reviews: { orderBy: { reviewedAt: "desc" }, take: 1, include: { reviewer: { select: { email: true } } } },
      manualVersion: { select: { version: true } },
    },
    orderBy: [{ encounterId: "asc" }, { createdAt: "asc" }],
  });
}

/** One row per suggested or confirmed complication (an encounter may have several; a complication may cite several notes). */
export async function complicationLevelRows(f: Filters = {}) {
  const preds = await loadPredictions(f);
  return preds.map((p) => {
    const last = p.reviews[0];
    const isFinal = FINAL.has(p.reviewStatus);
    const dates = p.evidence.map((e) => e.clinicalNote.dateOfService).filter(Boolean) as Date[];
    return {
      MRN: p.encounter.patient.mrn,
      CSN: p.encounter.csn,
      NOTE_ID: [...new Set(p.evidence.map((e) => e.clinicalNote.noteId))].join("; "),
      "Date of Service": dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))).toISOString().slice(0, 10) : "",
      "Event Date": p.complicationEventDate ? p.complicationEventDate.toISOString().slice(0, 10) : "",
      "Supporting Evidence": p.evidence.map((e) => `[${e.clinicalNote.noteId}${e.verified ? "" : " UNVERIFIED"}] ${e.evidenceText}`).join(" | "),
      "AI Suggested Complication": p.classificationStatus === "REVIEWER_ADDED" ? "" : p.predictedComplication,
      "AI Classification Status": p.classificationStatus,
      "Final Approved Complication": isFinal ? (p.finalComplication ?? "") : "",
      "STS Code": isFinal ? (p.finalStsCode ?? "") : (p.stsCode ?? ""),
      "STS Code Is Final": isFinal ? "YES" : "NO — unreviewed AI suggestion",
      "Review Status": p.reviewStatus,
      "Reviewer Comments": last?.comments ?? "",
      Reviewer: last?.reviewer.email ?? "",
      "Reviewed At": last?.reviewedAt.toISOString() ?? "",
      Response: p.aiExplanation ?? "",
      "Evidence Status": p.evidenceStatus,
      "Validation Issues": Array.isArray(p.validationIssues) ? (p.validationIssues as string[]).join("; ") : "",
      "Model Version": p.modelVersion ?? "",
      "Prompt Version": p.promptVersion ?? "",
      "Manual Reference": manualRef(p),
    };
  });
}

/** Original input row structure, with review columns appended. */
export async function noteLevelRows(f: Filters & { sourceFileId?: string } = {}) {
  const rows = await prisma.sourceRow.findMany({
    where: { sourceFile: { kind: "CLINICAL_NOTES" }, ...(f.sourceFileId ? { sourceFileId: f.sourceFileId } : {}) },
    orderBy: [{ sourceFileId: "asc" }, { rowNumber: "asc" }],
    include: { clinicalNote: { select: { id: true, encounterId: true } } },
  });
  const encounterFilter = f.encounterIds?.length ? new Set(f.encounterIds) : null;
  const preds = await loadPredictions(f);
  const byNote = new Map<string, typeof preds>();
  for (const p of preds)
    for (const e of p.evidence) {
      const list = byNote.get(e.clinicalNoteId) ?? [];
      if (!list.includes(p)) list.push(p);
      byNote.set(e.clinicalNoteId, list);
    }
  return rows
    .filter((r) => !encounterFilter || (r.clinicalNote && encounterFilter.has(r.clinicalNote.encounterId)))
    .map((r) => {
      const ps = r.clinicalNote ? (byNote.get(r.clinicalNote.id) ?? []) : [];
      const original = r.raw as Record<string, string>;
      return {
        ...original,
        IMPORT_ROW_STATUS: r.status,
        AI_SUGGESTED_COMPLICATIONS: ps
          .filter((p) => p.classificationStatus !== "REVIEWER_ADDED")
          .map((p) => p.predictedComplication)
          .join("; "),
        FINAL_APPROVED_COMPLICATIONS: ps
          .filter((p) => FINAL.has(p.reviewStatus))
          .map((p) => p.finalComplication)
          .join("; "),
        STS_CODES_FINAL: ps
          .filter((p) => FINAL.has(p.reviewStatus))
          .map((p) => p.finalStsCode ?? "")
          .filter(Boolean)
          .join("; "),
        REVIEW_STATUS: ps.map((p) => `${p.predictedComplication}: ${p.reviewStatus}`).join("; "),
        REVIEWER_COMMENTS: ps
          .map((p) => p.reviews[0]?.comments)
          .filter(Boolean)
          .join(" | "),
        AI_RESPONSE: ps
          .map((p) => p.aiExplanation)
          .filter(Boolean)
          .join(" | "),
        MODEL_VERSION: [...new Set(ps.map((p) => p.modelVersion).filter(Boolean))].join("; "),
        MANUAL_REFERENCE: [...new Set(ps.map(manualRef).filter(Boolean))].join("; "),
      };
    });
}

export async function renderExport(rows: Record<string, unknown>[], format: ExportFormat): Promise<Buffer> {
  const headers = rows.length ? Object.keys(rows[0]) : ["(no rows)"];
  if (format === "csv") {
    const csv = Papa.unparse({ fields: headers, data: rows.map((r) => headers.map((h) => safeCell(r[h]))) });
    return Buffer.from("﻿" + csv, "utf8");
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Complications");
  ws.addRow(headers).font = { bold: true };
  // Write every value as text so identifiers keep leading zeros.
  for (const r of rows) ws.addRow(headers.map((h) => safeCell(r[h])));
  ws.columns.forEach((c) => (c.numFmt = "@"));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
