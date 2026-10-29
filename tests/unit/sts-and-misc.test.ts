import { describe, expect, it } from "vitest";
import { checkManualIdentity } from "@/lib/sts/pdf-parser";
import { parseManual, extractCodes } from "@/lib/sts/rule-parser";
import { computeMetrics } from "@/lib/validation/metrics";
import { exportFileName, safeCell } from "@/lib/export/exporter";
import { hasRole, mapEntraRoles } from "@/lib/auth/roles";
import { scrub } from "@/lib/security/logger";
import { mostRestrictive } from "@/lib/security/gates";
import { verifySignature, typeFromName } from "@/lib/storage";

// Synthetic text in the CHSD Training Manual layout (TEST FIXTURE: made-up fields and codes, not STS content).
const hdr = (n: number) => `CHSD Training Manual - Version 9.9.9 Page ${n} of 5`;
const fixturePages = [
  "CONGENITAL HEART\nSURGERY DATABASE\nTRAINING MANUAL\nVERSION 9.9.9\nSociety of Thoracic Surgeons",
  `${hdr(2)}\nS9. TEST POSTOPERATIVE EVENTS\nLong Name: Test Postoperative Events - Multi-Select\nSeqNo: 1234\nShort Name: TestPostopEvents\nDatabase Table Name: TestOps\nData Source: User\nFormat: Multi-Select\nDefinition: Indicate the test complication that occurred.\nParentLongName: Test Parent\nParentHarvestCodes: 2\nHarvest Codes and Display Conditions:\nCode: Value (Display Condition):\n11 Test event alpha requiring
drainage (TEST)\n12 Test event beta`,
  `${hdr(3)}\nIntent/Clarification:\nCode only events within the test window.\nThis clarification continues on the next line.\nCode: Value: Definition:\n11 Test event alpha\nrequiring drainage\n(TEST)\nDefined: alpha fixture definition.\nTimeframe:\n12 hours after the test.\nCode this Event: when alpha occurs.\n12 Test event beta Defined: beta fixture definition on the value line.`,
  `${hdr(4)}\nGeneral Information Test Timeframes\nSome general paragraph that is long enough to be indexed as a loose chunk of text for testing search coverage across sections in the parser.`,
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
  const field = rules.find((r) => r.seqNumber === "1234" && !r.stsCode)!;
  it("keeps a field's definition and its clarification in one chunk with page numbers", () => {
    expect(field).toBeDefined();
    expect(field.longName).toBe("Test Postoperative Events - Multi-Select");
    expect(field.definition).toMatch(/test complication/);
    expect(field.intentClarification).toMatch(/continues on the next line/);
    expect(field.chunkText).toMatch(/Definition/);
    expect(field.chunkText).toMatch(/Intent\/Clarification/);
    expect(field.chunkText).not.toMatch(/Page 2 of 5/); // page furniture removed
    expect(field.pageNumber).toBe(2);
    expect(field.pageEnd).toBe(3);
    expect(field.shortName).toBe("TestPostopEvents");
    expect(field.dbTable).toBe("TestOps");
    expect(field.parentConditions).toMatch(/ParentHarvestCodes: 2/);
    expect(field.sectionName).toBe("S9. TEST POSTOPERATIVE EVENTS");
    expect(field.isComplicationRule).toBe(true);
  });
  it("extracts wrapped harvest codes and pairs each code with its own definition", () => {
    expect(field.validCodes).toEqual([
      { code: "11", value: "Test event alpha requiring drainage (TEST)" },
      { code: "12", value: "Test event beta" },
    ]);
    const coded = rules.filter((r) => r.stsCode);
    expect(coded.map((r) => [r.stsCode, r.complicationName, r.pageNumber])).toEqual([
      ["11", "Test event alpha requiring drainage (TEST)", 3],
      ["12", "Test event beta", 3],
    ]);
    // "Timeframe: 12 hours…" must not be mistaken for entry 12.
    expect(coded[0].definition).toMatch(/^Defined: alpha fixture definition\.[\s\S]*Timeframe:\n12 hours[\s\S]*Code this Event: when alpha occurs\.$/);
    expect(coded[1].definition).toBe("Defined: beta fixture definition on the value line.");
    expect(coded[0].chunkText).toMatch(/SeqNo: 1234/);
  });
  it("treats 'General Information' pages as their own section", () => {
    expect(rules.some((r) => r.sectionName === "General Information Test Timeframes" && !r.longName)).toBe(true);
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
