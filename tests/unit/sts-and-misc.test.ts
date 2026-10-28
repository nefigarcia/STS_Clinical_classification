import { describe, expect, it } from "vitest";
import { checkManualIdentity } from "@/lib/sts/pdf-parser";
import { parseManual, extractCodes } from "@/lib/sts/rule-parser";
import { computeMetrics } from "@/lib/validation/metrics";
import { exportFileName, safeCell } from "@/lib/export/exporter";
import { hasRole, mapEntraRoles } from "@/lib/auth/roles";
import { scrub } from "@/lib/security/logger";
import { mostRestrictive } from "@/lib/security/gates";
import { verifySignature, typeFromName } from "@/lib/storage";

// Synthetic manual-like text in a labelled-field layout (TEST FIXTURE, not STS content).
const fixturePages = [
  "Society of Thoracic Surgeons\nCongenital Heart Surgery Database\nTraining Manual\nVersion 9.9.9",
  "POSTOPERATIVE EVENTS\nLong Name: Test Postoperative Complication\nShort Name: TestComp\nSeq. #: 1234\nTable: TestOps\nDefinition: Indicate the test complication that occurred.\nIntent/Clarification: Code only events within the test window.\nThis clarification continues on the next line.",
  "1 = Test event alpha\n2 = Test event beta\nNote: fixture note text.",
  "OTHER SECTION\nSome general paragraph that is long enough to be indexed as a loose chunk of text for testing search coverage across sections in the parser.",
];

describe("STS manual identity check", () => {
  it("accepts a document that identifies as the STS CHSD training manual", () => {
    const r = checkManualIdentity(fixturePages);
    expect(r.isStsChsdManual).toBe(true);
    expect(r.detectedVersion).toBe("9.9.9");
  });
  it("rejects unrelated documents such as a vendor order form", () => {
    const r = checkManualIdentity(["Order Form\nQuote Number: Q-000000\nRenewable Subscription\nData Integration On-Premise\nTotal 0.00"]);
    expect(r.isStsChsdManual).toBe(false);
  });
});

describe("rule parser", () => {
  const rules = parseManual(fixturePages);
  const field = rules.find((r) => r.longName === "Test Postoperative Complication" && !r.stsCode)!;
  it("keeps a field's definition and its clarification in one chunk with page numbers", () => {
    expect(field).toBeDefined();
    expect(field.definition).toMatch(/test complication/);
    expect(field.intentClarification).toMatch(/continues on the next line/);
    expect(field.chunkText).toMatch(/Definition/);
    expect(field.chunkText).toMatch(/Intent\/Clarification/);
    expect(field.pageNumber).toBe(2);
    expect(field.pageEnd).toBe(3);
    expect(field.shortName).toBe("TestComp");
    expect(field.seqNumber).toBe("1234");
    expect(field.sectionName).toBe("POSTOPERATIVE EVENTS");
    expect(field.isComplicationRule).toBe(true);
  });
  it("extracts coded values into code-level rules", () => {
    expect(field.validCodes).toEqual([
      { code: "1", value: "Test event alpha" },
      { code: "2", value: "Test event beta" },
    ]);
    const coded = rules.filter((r) => r.stsCode);
    expect(coded.map((r) => [r.stsCode, r.complicationName])).toEqual([
      ["1", "Test event alpha"],
      ["2", "Test event beta"],
    ]);
  });
  it("indexes loose section text", () => {
    expect(rules.some((r) => r.sectionName === "OTHER SECTION")).toBe(true);
  });
  it("parses Code/Value pairs", () => {
    expect(extractCodes("Code: 12 Value: Foo bar")).toEqual([{ code: "12", value: "Foo bar" }]);
  });
});

describe("evaluation metrics", () => {
  const data = [
    {
      encounterId: "e1",
      mrn: "1",
      csn: "1",
      date: null,
      expected: ["Pneumothorax", "Chylothorax"],
      expectedSupportingNoteIds: ["n1"],
      processed: true,
      predicted: [
        { label: "pneumothorax", uncertain: false, evidenceVerified: true, evidenceNoteIds: ["n1"] },
        { label: "Seizure", uncertain: false, evidenceVerified: true, evidenceNoteIds: ["n2"] },
      ],
    },
    {
      encounterId: "e2",
      mrn: "2",
      csn: "2",
      date: null,
      expected: ["Reintubation"],
      expectedSupportingNoteIds: [],
      processed: true,
      predicted: [{ label: "Reintubation", uncertain: false, evidenceVerified: true, evidenceNoteIds: ["n9"] }],
    },
    { encounterId: "e3", mrn: "3", csn: "3", date: null, expected: ["Seizure"], expectedSupportingNoteIds: [], processed: false, predicted: [] },
  ];
  it("computes multi-label precision/recall/F1/exact match at encounter level", () => {
    const { metrics, rows } = computeMetrics(data, {});
    expect(metrics.tp).toBe(2);
    expect(metrics.fp).toBe(1);
    expect(metrics.fn).toBe(1);
    expect(metrics.precision).toBeCloseTo(2 / 3);
    expect(metrics.recall).toBeCloseTo(2 / 3);
    expect(metrics.exactMatchAccuracy).toBeCloseTo(0.5);
    expect(metrics.evidenceCitationAccuracy).toBe(1);
    expect(rows.find((r) => r.result === "incorrect_classification")).toMatchObject({ expected: "Chylothorax", predicted: "Seizure" });
    expect(rows.find((r) => r.encounterId === "e3")!.result).toBe("unreviewed");
  });
  it("applies the label map", () => {
    const { metrics } = computeMetrics(
      [
        {
          ...data[1],
          expected: ["Interventional cath"],
          predicted: [{ label: "Unplanned interventional catheterization", uncertain: false, evidenceVerified: null, evidenceNoteIds: [] }],
        },
      ],
      { "interventional cath": "Unplanned interventional catheterization" },
    );
    expect(metrics.tp).toBe(1);
  });
});

describe("exports, roles, security helpers", () => {
  it("names files OutputComplication_YYYYMMDD_HHMMSS", () => {
    expect(exportFileName("complication", "csv", new Date(2026, 9, 27, 8, 5, 9))).toBe("OutputComplication_20261027_080509.csv");
    expect(exportFileName("note", "xlsx", new Date(2026, 9, 27, 8, 5, 9))).toBe("OutputComplication_20261027_080509_NoteLevel.xlsx");
  });
  it("neutralizes spreadsheet formulas but keeps identifiers and text intact", () => {
    expect(safeCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(safeCell("0001234")).toBe("0001234");
    expect(safeCell("- normal bullet")).toBe("- normal bullet");
  });
  it("enforces role hierarchy and maps Entra app roles", () => {
    expect(hasRole("ADMIN", "REVIEWER")).toBe(true);
    expect(hasRole("READ_ONLY", "REVIEWER")).toBe(false);
    expect(mapEntraRoles(["STS.Reviewer", "STS.ReadOnly"], undefined)).toBe("REVIEWER");
    expect(mapEntraRoles(["X"], '{"X":"ADMIN"}')).toBe("ADMIN");
    expect(mapEntraRoles([], undefined)).toBeNull();
  });
  it("scrubs identifiers and emails from logs", () => {
    expect(scrub("MRN 0001234 csn 39653624 user a.b@x.org")).toBe("MRN [id] csn [id] user [email]");
  });
  it("treats mixed datasets as their most restrictive class", () => {
    expect(mostRestrictive(["SYNTHETIC", "PHI"])).toBe("PHI");
    expect(mostRestrictive(["SYNTHETIC"])).toBe("SYNTHETIC");
  });
  it("validates upload signatures, not just extensions", () => {
    expect(typeFromName("x.exe").type).toBeNull();
    expect(verifySignature("pdf", Buffer.from("PK\u0003\u0004"))).toMatch(/not a PDF/);
    expect(verifySignature("xlsx", Buffer.from("%PDF-1.7"))).toMatch(/not a valid Excel/);
    expect(verifySignature("pdf", Buffer.from("%PDF-1.7"))).toBeNull();
  });
});
