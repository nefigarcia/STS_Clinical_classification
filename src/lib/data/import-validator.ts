import type { ColumnMapping, ImportKind } from "./column-mapping";
import { missingRequired } from "./column-mapping";
import { cleanText, normalizeDate, normalizeIdentifier, sha256 } from "./normalization";

export type Severity = "error" | "warning";
export type RowIssue = { row: number; field: string; severity: Severity; message: string };

export type NormalizedNoteRow = {
  rowNumber: number;
  raw: Record<string, string>;
  status: "VALID" | "INVALID" | "DUPLICATE";
  issues: RowIssue[];
  mrn: string | null;
  csn: string | null;
  noteId: string | null;
  noteType: string | null;
  noteText: string | null;
  contentHash: string | null;
  dateOfService: Date | null;
  dateOfServiceRaw: string;
  filedDate: Date | null;
  flag: string | null;
};

export type NormalizedHistoricalRow = {
  rowNumber: number;
  raw: Record<string, string>;
  status: "VALID" | "INVALID" | "DUPLICATE";
  issues: RowIssue[];
  mrn: string | null;
  csn: string | null;
  dateOfService: Date | null;
  dateOfServiceRaw: string;
  complication: string | null;
  noteInfo: string | null;
  keyWords: string | null;
  additionalInfo: string | null;
};

export type ImportReport = {
  kind: ImportKind;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  uniquePatients: number;
  uniqueEncounters: number;
  notesByEncounter: { mrn: string; csn: string; notes: number; uniqueNotes: number }[];
  notesRequiringAttention: number;
  missingIdentifiers: number;
  blankNotes: number;
  missingRequiredColumns: string[];
  issues: RowIssue[];
  issuesTruncated: boolean;
  warnings: string[];
};

const MAX_ISSUES = 500;
/** Header row is row 1, so the first data row is spreadsheet row 2. */
const rowNum = (i: number) => i + 2;

function get(raw: Record<string, string>, mapping: ColumnMapping, key: string): string {
  const col = mapping[key];
  return col ? (raw[col] ?? "") : "";
}

export function validateNotes(rows: Record<string, string>[], mapping: ColumnMapping, headers: string[]) {
  const missingCols = missingRequired("CLINICAL_NOTES", mapping, headers);
  const out: NormalizedNoteRow[] = [];
  const seen = new Map<string, number>();
  const csnOwner = new Map<string, string>();
  rows.forEach((raw, i) => {
    const n = rowNum(i);
    const issues: RowIssue[] = [];
    const add = (field: string, severity: Severity, message: string) => issues.push({ row: n, field, severity, message });
    const mrn = normalizeIdentifier(get(raw, mapping, "mrn"), "MRN");
    const csn = normalizeIdentifier(get(raw, mapping, "csn"), "CSN");
    const noteId = normalizeIdentifier(get(raw, mapping, "noteId"), "NOTE_ID");
    for (const [f, r] of [
      ["MRN", mrn],
      ["CSN", csn],
      ["NOTE_ID", noteId],
    ] as const) {
      if (r.issue) add(f, r.value ? "warning" : "error", r.issue);
    }
    const textRaw = get(raw, mapping, "noteText");
    const noteText = textRaw.trim() && textRaw.trim().toUpperCase() !== "NULL" ? textRaw : null;
    if (!noteText) add("COMBINED_NOTE_TEXT", "error", "clinical note text is blank");
    const dos = normalizeDate(get(raw, mapping, "dateOfService"));
    if (dos.issue) add("DATE_OF_SERVICE", "warning", `Date of Service: ${dos.issue}`);
    const filed = mapping.filedDate ? normalizeDate(get(raw, mapping, "filedDate")) : null;
    if (filed?.issue && filed.raw && filed.raw.toUpperCase() !== "NULL") add("LST_FILED_INST", "warning", `Filed date: ${filed.issue}`);
    if (mrn.value && csn.value) {
      const owner = csnOwner.get(csn.value);
      if (owner && owner !== mrn.value) add("CSN", "error", "CSN appears under more than one MRN in this file");
      else csnOwner.set(csn.value, mrn.value);
    }
    const contentHash = noteText ? sha256(noteText) : null;
    let status: NormalizedNoteRow["status"] = issues.some((x) => x.severity === "error") ? "INVALID" : "VALID";
    if (status === "VALID") {
      const key = `${mrn.value}|${csn.value}|${noteId.value}|${contentHash}`;
      const first = seen.get(key);
      if (first !== undefined) {
        status = "DUPLICATE";
        add("row", "warning", `exact duplicate of row ${first} (same MRN, CSN, NOTE_ID and note text)`);
      } else seen.set(key, n);
    }
    out.push({
      rowNumber: n,
      raw,
      status,
      issues,
      mrn: mrn.value,
      csn: csn.value,
      noteId: noteId.value,
      noteType: cleanText(get(raw, mapping, "noteType")),
      noteText,
      contentHash,
      dateOfService: dos.date,
      dateOfServiceRaw: dos.raw,
      filedDate: filed?.date ?? null,
      flag: cleanText(get(raw, mapping, "flag")),
    });
  });

  // Same NOTE_ID with differing text inside an encounter = revision/addendum: keep both, flag for attention.
  const textsById = new Map<string, Set<string>>();
  for (const r of out) {
    if (r.status === "INVALID" || !r.contentHash) continue;
    const k = `${r.csn}|${r.noteId}`;
    (textsById.get(k) ?? textsById.set(k, new Set()).get(k)!).add(r.contentHash);
  }
  for (const r of out) {
    if (r.status === "VALID" && (textsById.get(`${r.csn}|${r.noteId}`)?.size ?? 0) > 1) {
      r.issues.push({
        row: r.rowNumber,
        field: "NOTE_ID",
        severity: "warning",
        message: "NOTE_ID has multiple distinct text versions (revision or addendum); each version is kept",
      });
    }
  }
  return { rows: out, report: buildReport("CLINICAL_NOTES", out, missingCols) };
}

export function validateHistorical(rows: Record<string, string>[], mapping: ColumnMapping, headers: string[]) {
  const missingCols = missingRequired("HISTORICAL_COMPLICATIONS", mapping, headers);
  const out: NormalizedHistoricalRow[] = [];
  const seen = new Map<string, number>();
  rows.forEach((raw, i) => {
    const n = rowNum(i);
    const issues: RowIssue[] = [];
    const add = (field: string, severity: Severity, message: string) => issues.push({ row: n, field, severity, message });
    const mrn = normalizeIdentifier(get(raw, mapping, "mrn"), "MRN");
    const csn = normalizeIdentifier(get(raw, mapping, "csn"), "CSN");
    for (const [f, r] of [
      ["MRN", mrn],
      ["CSN", csn],
    ] as const)
      if (r.issue) add(f, r.value ? "warning" : "error", r.issue);
    const dos = normalizeDate(get(raw, mapping, "dateOfService"));
    if (dos.issue) add("Date of Service", "warning", `Date of Service: ${dos.issue}`);
    const complication = cleanText(get(raw, mapping, "complication"));
    if (!complication) add("Complication", "error", "complication label is blank");
    let status: NormalizedHistoricalRow["status"] = issues.some((x) => x.severity === "error") ? "INVALID" : "VALID";
    const key = `${mrn.value}|${csn.value}|${dos.iso}|${complication?.toLowerCase()}`;
    if (status === "VALID") {
      if (seen.has(key)) {
        status = "DUPLICATE";
        add("row", "warning", `duplicate of row ${seen.get(key)}`);
      } else seen.set(key, n);
    }
    out.push({
      rowNumber: n,
      raw,
      status,
      issues,
      mrn: mrn.value,
      csn: csn.value,
      dateOfService: dos.date,
      dateOfServiceRaw: dos.raw,
      complication,
      noteInfo: cleanText(get(raw, mapping, "noteInfo")),
      keyWords: cleanText(get(raw, mapping, "keyWords")),
      additionalInfo: cleanText(get(raw, mapping, "additionalInfo")),
    });
  });
  return { rows: out, report: buildReport("HISTORICAL_COMPLICATIONS", out, missingCols) };
}

function buildReport(kind: ImportKind, rows: (NormalizedNoteRow | NormalizedHistoricalRow)[], missingRequiredColumns: string[]): ImportReport {
  const usable = rows.filter((r) => r.status !== "INVALID");
  const patients = new Set(usable.map((r) => r.mrn).filter(Boolean));
  const enc = new Map<string, { mrn: string; csn: string; notes: number; hashes: Set<string> }>();
  for (const r of usable) {
    if (!r.mrn || !r.csn) continue;
    const k = `${r.mrn}|${r.csn}`;
    const e = enc.get(k) ?? { mrn: r.mrn, csn: r.csn, notes: 0, hashes: new Set<string>() };
    e.notes++;
    if ("noteId" in r) e.hashes.add(`${r.noteId}|${r.contentHash}`);
    enc.set(k, e);
  }
  const allIssues = rows.flatMap((r) => r.issues);
  const warnings: string[] = [];
  if (missingRequiredColumns.length) warnings.push(`Required columns not mapped: ${missingRequiredColumns.join(", ")}`);
  return {
    kind,
    totalRows: rows.length,
    validRows: rows.filter((r) => r.status === "VALID").length,
    invalidRows: rows.filter((r) => r.status === "INVALID").length,
    duplicateRows: rows.filter((r) => r.status === "DUPLICATE").length,
    uniquePatients: patients.size,
    uniqueEncounters: enc.size,
    notesByEncounter: [...enc.values()].map((e) => ({
      mrn: e.mrn,
      csn: e.csn,
      notes: e.notes,
      uniqueNotes: kind === "CLINICAL_NOTES" ? e.hashes.size : e.notes,
    })),
    notesRequiringAttention: rows.filter((r) => r.issues.length > 0 && r.status !== "DUPLICATE").length,
    missingIdentifiers: rows.filter((r) => r.issues.some((i) => /missing/.test(i.message) && ["MRN", "CSN", "NOTE_ID"].includes(i.field))).length,
    blankNotes: rows.filter((r) => r.issues.some((i) => i.field === "COMBINED_NOTE_TEXT")).length,
    missingRequiredColumns,
    issues: allIssues.slice(0, MAX_ISSUES),
    issuesTruncated: allIssues.length > MAX_ISSUES,
    warnings,
  };
}
