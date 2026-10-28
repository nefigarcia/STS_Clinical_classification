import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { normalizeDate, normalizeIdentifier, isNullToken, sha256 } from "@/lib/data/normalization";
import { cellToString, readExcel, listWorksheets } from "@/lib/data/excel-reader";
import { readCsv } from "@/lib/data/csv-reader";
import { suggestMapping, missingRequired, detectKind } from "@/lib/data/column-mapping";
import { validateNotes, validateHistorical } from "@/lib/data/import-validator";
import { SYN_COMP_HEADERS, SYN_NOTE_HEADERS, syntheticComplications, syntheticNotes, toCsv } from "@/lib/data/synthetic";

describe("identifier normalization", () => {
  it("preserves leading zeros and exact text", () => {
    expect(normalizeIdentifier(" 0001234 ", "MRN")).toEqual({ value: "0001234" });
    expect(normalizeIdentifier("A00123", "CSN").value).toBe("A00123");
  });
  it("flags missing, NULL tokens and spreadsheet artefacts without rewriting", () => {
    expect(normalizeIdentifier("NULL", "MRN").value).toBeNull();
    expect(normalizeIdentifier("", "MRN").issue).toMatch(/missing/);
    const r = normalizeIdentifier("1234567.0", "MRN");
    expect(r.value).toBe("1234567.0");
    expect(r.issue).toMatch(/decimal/);
    expect(normalizeIdentifier("1.23E+11", "CSN").issue).toMatch(/scientific/);
  });
  it("recognizes null tokens", () => {
    expect(isNullToken("null")).toBe(true);
    expect(isNullToken(" N/A ")).toBe(true);
    expect(isNullToken("0")).toBe(false);
  });
});

describe("date normalization", () => {
  it("parses ISO, US and Excel serial formats without timezone shift", () => {
    expect(normalizeDate("2026-01-07T07:30:00").iso).toBe("2026-01-07T07:30:00");
    expect(normalizeDate("1/7/2026").iso).toBe("2026-01-07");
    expect(normalizeDate("1/7/2026 1:05 PM").iso).toBe("2026-01-07T13:05:00");
    expect(normalizeDate("46029").iso).toBe("2026-01-07");
  });
  it("rejects impossible dates and reports NULL", () => {
    expect(normalizeDate("2026-02-30").date).toBeNull();
    expect(normalizeDate("NULL").issue).toMatch(/missing/);
  });
});

describe("excel and csv readers", () => {
  it("keeps numeric identifiers exact and honors zero-padded number formats", () => {
    expect(cellToString(12345678)).toBe("12345678");
    expect(cellToString(1234, "000000")).toBe("001234");
    expect(cellToString({ richText: [{ text: "ab" }, { text: "c" }] } as never)).toBe("abc");
    expect(cellToString(new Date(Date.UTC(2026, 0, 7, 7, 30)))).toBe("2026-01-07T07:30:00");
  });
  it("round-trips an in-memory workbook with text identifiers and multiple sheets", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Other").addRow(["x"]);
    const ws = wb.addWorksheet("INTERNAL 2 CSN");
    ws.addRow(SYN_NOTE_HEADERS);
    for (const r of syntheticNotes()) ws.addRow(SYN_NOTE_HEADERS.map((h) => r[h]));
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    expect(await listWorksheets(buf)).toEqual(["Other", "INTERNAL 2 CSN"]);
    const t = await readExcel(buf, "INTERNAL 2 CSN");
    expect(t.headers).toEqual(SYN_NOTE_HEADERS);
    expect(t.rows[0].MRN).toBe("0001001");
    expect(t.rows[0].NOTE_ID).toBe("000900001");
  });
  it("parses CSV as strings only", () => {
    const t = readCsv("﻿MRN,CSN\n0001,00002\n");
    expect(t.rows).toEqual([{ MRN: "0001", CSN: "00002" }]);
  });
});

describe("column mapping", () => {
  it("auto-maps the SampleNotes and Complications headers", () => {
    const m = suggestMapping("CLINICAL_NOTES", SYN_NOTE_HEADERS);
    expect(m).toMatchObject({
      mrn: "MRN",
      csn: "CSN",
      noteId: "NOTE_ID",
      noteText: "COMBINED_NOTE_TEXT",
      dateOfService: "DATE_OF_SERVICE",
      flag: "Flag Notes",
    });
    expect(missingRequired("CLINICAL_NOTES", m, SYN_NOTE_HEADERS)).toEqual([]);
    expect(suggestMapping("HISTORICAL_COMPLICATIONS", SYN_COMP_HEADERS).complication).toBe("Complication");
    expect(detectKind(SYN_COMP_HEADERS)).toBe("HISTORICAL_COMPLICATIONS");
  });
  it("supports mapping when headers differ", () => {
    const headers = ["Patient MRN", "Encounter", "Doc ID", "Body", "Service Date"];
    const m = { mrn: "Patient MRN", csn: "Encounter", noteId: "Doc ID", noteText: "Body", dateOfService: "Service Date" };
    expect(missingRequired("CLINICAL_NOTES", m, headers)).toEqual([]);
    const { report } = validateNotes([{ "Patient MRN": "007", Encounter: "1", "Doc ID": "9", Body: "text", "Service Date": "2026-01-01" }], m, headers);
    expect(report.validRows).toBe(1);
  });
});

describe("import validation", () => {
  const table = readCsv(toCsv(SYN_NOTE_HEADERS, syntheticNotes()));
  const mapping = suggestMapping("CLINICAL_NOTES", table.headers);
  const { rows, report } = validateNotes(table.rows, mapping, table.headers);

  it("reports invalid and duplicate rows instead of dropping them", () => {
    expect(report.totalRows).toBe(11);
    expect(report.invalidRows).toBe(2);
    expect(report.duplicateRows).toBe(1);
    expect(report.validRows).toBe(8);
    expect(rows).toHaveLength(11);
    expect(report.missingIdentifiers).toBe(1);
    expect(report.blankNotes).toBe(1);
  });
  it("groups notes by patient and encounter", () => {
    expect(report.uniquePatients).toBe(2);
    expect(report.uniqueEncounters).toBe(2);
    const a = report.notesByEncounter.find((e) => e.csn === "00500101")!;
    expect(a.notes).toBe(6);
    expect(a.uniqueNotes).toBe(5);
  });
  it("hashes exact content for duplicate detection", () => {
    const dup = rows.find((r) => r.status === "DUPLICATE")!;
    expect(dup.contentHash).toBe(sha256(dup.noteText!));
  });
  it("detects one CSN under two MRNs", () => {
    const r = validateNotes(
      [
        { MRN: "1", CSN: "9", NOTE_ID: "1", COMBINED_NOTE_TEXT: "a", DATE_OF_SERVICE: "2026-01-01" },
        { MRN: "2", CSN: "9", NOTE_ID: "2", COMBINED_NOTE_TEXT: "b", DATE_OF_SERVICE: "2026-01-01" },
      ],
      mapping,
      table.headers,
    );
    expect(r.report.invalidRows).toBe(1);
  });
  it("keeps differing text versions of one NOTE_ID with a warning", () => {
    const r = validateNotes(
      [
        { MRN: "1", CSN: "9", NOTE_ID: "5", COMBINED_NOTE_TEXT: "v1", DATE_OF_SERVICE: "2026-01-01" },
        { MRN: "1", CSN: "9", NOTE_ID: "5", COMBINED_NOTE_TEXT: "v2 addendum", DATE_OF_SERVICE: "2026-01-01" },
      ],
      mapping,
      table.headers,
    );
    expect(r.report.validRows).toBe(2);
    expect(r.rows[0].issues.some((i) => /multiple distinct text versions/.test(i.message))).toBe(true);
  });
  it("validates historical labels and preserves originals", () => {
    const t = readCsv(toCsv(SYN_COMP_HEADERS, syntheticComplications()));
    const h = validateHistorical(t.rows, suggestMapping("HISTORICAL_COMPLICATIONS", t.headers), t.headers);
    expect(h.report.validRows).toBe(5);
    expect(h.rows[1].complication).toBe("Arrhythmia, temp pacer");
  });
});
