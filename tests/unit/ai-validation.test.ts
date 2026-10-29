import { describe, expect, it } from "vitest";
import { buildChecklist, isScreenableCode, parseTimeframeClasses } from "@/lib/sts/criteria";
import { checkEventDate, computeWindow } from "@/lib/ai/timeframe";
import { adjudicationSchema, buildAdjudicationPrompt, decide, validateAdjudication, type Passage } from "@/lib/ai/adjudication";
import { novelSpans, packBatches, screenSchema, validateScreen } from "@/lib/ai/screening";
import { mapPool } from "@/lib/util/pool";
import { locateExcerpt } from "@/lib/ai/excerpt";
import { computeCost } from "@/lib/ai/cost-tracker";

// TEST FIXTURE definition in the CHSD layout (made-up wording, not STS content).
const FIXTURE_DEF = `Defined: a fixture collection of gas requiring
intervention (drainage).
Timeframe: Other postop event timeframe
See General Information Postoperative Event
Timeframe for additional information.
Code this Event: if the patient experiences the fixture event
requiring chest tube insertion during the defined
timeframe.
Includes the following procedures:
• chest tube insertion
• needle aspiration
Do not include fixture events followed with serial
radiographs without intervention.`;

const checklist = buildChecklist("T190", "Fixture pneumothorax", FIXTURE_DEF);
const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("STS criteria checklist", () => {
  it("builds Defined / Code-this-Event / exclusion criteria and keeps inclusion bullets with C1", () => {
    expect(checklist.criteria.map((c) => c.id)).toEqual(["D1", "C1", "E1"]);
    expect(checklist.criteria[0].text).toBe("a fixture collection of gas requiring intervention (drainage).");
    expect(checklist.criteria[1].text).toMatch(/Includes the following procedures:\n• chest tube insertion\n• needle aspiration/);
    expect(checklist.criteria[2]).toMatchObject({ kind: "exclusion", text: expect.stringMatching(/^Do not include fixture events/) });
  });
  it("parses timeframe classes", () => {
    expect(checklist.timeframe).toMatchObject({ intraoperative: false, major: false, other: true });
    expect(parseTimeframeClasses("Timeframe: Major and Intraoperative event timeframe.\nSee General")).toMatchObject({
      intraoperative: true,
      major: true,
      other: false,
    });
  });
  it("skips non-detectable codes", () => {
    expect(isScreenableCode("17", "No intra or post operative events")).toBe(false);
    expect(isScreenableCode("900", "Other event")).toBe(false);
    expect(isScreenableCode("190", "Pneumothorax, Requiring drainage")).toBe(true);
  });
});

describe("deterministic STS timeframe engine", () => {
  const other = { intraoperative: false, major: false, other: true, raw: null };
  const major = { intraoperative: false, major: true, other: false, raw: null };
  const intra = { intraoperative: true, major: false, other: false, raw: null };
  const dates = { surgeryDate: d("2026-01-05"), orExitAt: d("2026-01-05"), hospitalDischargeDate: d("2026-02-20"), databaseDischargeDate: d("2026-03-15") };

  it("uses the later of POD 30 and hospital discharge for other events", () => {
    const w = computeWindow(other, dates);
    expect(w.end!.toISOString().slice(0, 10)).toBe("2026-02-20");
    expect(checkEventDate(d("2026-02-19"), w)).toBe("in_window");
    expect(checkEventDate(d("2026-03-01"), w)).toBe("after_window");
  });
  it("extends major events to the end of the episode of care", () => {
    const w = computeWindow(major, dates);
    expect(checkEventDate(d("2026-03-01"), w)).toBe("in_window");
  });
  it("uses POD 30 when discharge is earlier, and rejects events before the index operation", () => {
    const w = computeWindow(other, { ...dates, hospitalDischargeDate: d("2026-01-12") });
    expect(w.end!.toISOString().slice(0, 10)).toBe("2026-02-04");
    expect(checkEventDate(d("2026-01-03"), w)).toBe("before_window");
  });
  it("limits intraoperative-only events to the operation day", () => {
    const w = computeWindow(intra, dates);
    expect(checkEventDate(d("2026-01-05"), w)).toBe("in_window");
    expect(checkEventDate(d("2026-01-06"), w)).toBe("after_window");
  });
  it("never guesses: unknown dates make the check unverifiable", () => {
    expect(checkEventDate(d("2026-01-06"), computeWindow(other, { ...dates, surgeryDate: null }))).toBe("unverifiable");
    expect(checkEventDate(null, computeWindow(other, dates))).toBe("unverifiable");
    // Past POD 30 with unknown discharge cannot be judged out of window.
    expect(checkEventDate(d("2026-02-10"), computeWindow(other, { ...dates, hospitalDischargeDate: null }))).toBe("unverifiable");
  });
});

const passages: Passage[] = [
  {
    label: "P1",
    clinicalNoteId: "cn2",
    noteId: "000900002",
    noteType: "ICU Progress Note",
    date: d("2026-01-06"),
    start: 100,
    end: 200,
    text: "POD1. Chest X-ray shows new right pneumothorax; chest tube placed at bedside.",
  },
  {
    label: "P2",
    clinicalNoteId: "cn3",
    noteId: "000900003",
    noteType: "ICU Progress Note",
    date: d("2026-01-07"),
    start: 50,
    end: 150,
    text: "Small apical pneumothorax followed with serial radiographs, no intervention.",
  },
];
type Ans = { id: string; status: "met" | "not_met" | "unclear"; evidence: { passageRef: string; excerpt: string }[]; rationale: string };
const out = (criteria: Ans[]) => adjudicationSchema.parse({ criteria, eventDate: "2026-01-06", explanation: "x" });
const met = (id: string, ref = "P1", excerpt = "new right pneumothorax; chest tube placed"): Ans => ({
  id,
  status: "met",
  evidence: [{ passageRef: ref, excerpt }],
  rationale: "",
});
const st = (id: string, status: Ans["status"]): Ans => ({ id, status, evidence: [], rationale: "" });

describe("adjudication validation and deterministic decision", () => {
  it("verifies quotes against passages and maps them to real NOTE_IDs with note offsets", () => {
    const { results } = validateAdjudication(out([met("D1"), met("C1"), st("E1", "not_met")]), checklist, passages);
    expect(results[0].evidence[0]).toMatchObject({ noteId: "000900002", clinicalNoteId: "cn2", verified: true });
    expect(results[0].evidence[0].start).toBe(100 + passages[0].text.indexOf("new right"));
    expect(decide(results, "in_window")).toMatchObject({ outcome: "positive", classificationStatus: "SUGGESTED", reviewStatus: "PENDING" });
  });
  it("downgrades a 'met' without verifiable evidence (fabricated quote) to unclear → human review", () => {
    const { results, issues } = validateAdjudication(
      out([met("D1"), met("C1", "P1", "massive tension pneumothorax"), st("E1", "not_met")]),
      checklist,
      passages,
    );
    expect(results[1].effectiveStatus).toBe("unclear");
    expect(issues.join()).toMatch(/not found verbatim/);
    expect(decide(results, "in_window")).toMatchObject({ outcome: "uncertain", reviewStatus: "NEEDS_REVIEW" });
  });
  it("excludes when an STS exclusion applies with evidence", () => {
    const { results } = validateAdjudication(
      out([
        met("D1", "P2", "Small apical pneumothorax"),
        met("C1", "P2", "Small apical pneumothorax"),
        met("E1", "P2", "followed with serial radiographs, no intervention"),
      ]),
      checklist,
      passages,
    );
    expect(decide(results, "in_window")).toMatchObject({ outcome: "negative", classificationStatus: "EXCLUDED" });
  });
  it("excludes when a required criterion is not met", () => {
    const { results } = validateAdjudication(out([met("D1"), st("C1", "not_met"), st("E1", "not_met")]), checklist, passages);
    expect(decide(results, "in_window").outcome).toBe("negative");
  });
  it("treats unanswered criteria as unclear and ignores unknown ids", () => {
    const { results, issues } = validateAdjudication(out([met("D1"), met("Z9")]), checklist, passages);
    expect(results.find((r) => r.id === "C1")!.effectiveStatus).toBe("unclear");
    expect(issues.join()).toMatch(/unknown criterion "Z9"/);
  });
  it("applies the timeframe deterministically after the criteria", () => {
    const { results } = validateAdjudication(out([met("D1"), met("C1"), st("E1", "not_met")]), checklist, passages);
    expect(decide(results, "before_window")).toMatchObject({ outcome: "negative", classificationStatus: "EXCLUDED" });
    expect(decide(results, "after_window").outcome).toBe("negative");
    expect(decide(results, "unverifiable")).toMatchObject({ outcome: "positive", reviewStatus: "NEEDS_REVIEW" });
  });
  it("flags positives whose exclusions could not be ruled out", () => {
    const { results } = validateAdjudication(out([met("D1"), met("C1"), st("E1", "unclear")]), checklist, passages);
    expect(decide(results, "in_window")).toMatchObject({ outcome: "positive", reviewStatus: "NEEDS_REVIEW" });
  });
  it("never includes patient identifiers in the adjudication prompt", () => {
    const p = buildAdjudicationPrompt({ checklist, manualVersion: "TEST", timeline: "Index operation date: 2026-01-05", passages, examples: [] });
    expect(p).not.toContain("000900002");
    expect(p).not.toContain("cn2");
    expect(p).toContain('<criterion id="E1" kind="exclusion">');
    expect(p).toContain('label="P1"');
  });
});

describe("screening: copy-forward removal, batching, validation", () => {
  const note = (id: string, day: number, text: string) => ({ id, combinedNoteText: text, noteType: "ICU Progress Note", dateOfService: d(`2026-01-0${day}`) });

  it("screens only sentences not seen earlier in the encounter, with exact note offsets", () => {
    const n1 = note("a", 1, "Vitals stable. Plan per team. New right pneumothorax; chest tube placed.");
    const n2 = note("b", 2, "Vitals stable.  Plan per team. Chest tube removed today. New right pneumothorax; chest tube placed.");
    const { spans, totalChars, novelChars } = novelSpans([n1, n2]);
    expect(spans.map((s) => [s.clinicalNoteId, s.text])).toEqual([
      ["a", "Vitals stable. Plan per team. New right pneumothorax; chest tube placed."],
      ["b", "Chest tube removed today."],
    ]);
    for (const s of spans) expect([n1, n2].find((n) => n.id === s.clinicalNoteId)!.combinedNoteText.slice(s.start, s.end)).toBe(s.text);
    expect(novelChars).toBeLessThan(totalChars);
  });

  it("packs spans from several notes into batches and splits oversized spans", () => {
    const s = (id: string, len: number) => ({ clinicalNoteId: id, noteType: null, date: null, start: 0, end: len, text: "x".repeat(len) });
    const batches = packBatches([s("a", 400), s("b", 400), s("c", 400), s("d", 2500)], 1000);
    expect(batches.map((b) => b.map((x) => `${x.clinicalNoteId}:${x.text.length}`))).toEqual([
      ["a:400", "b:400"],
      ["c:400"],
      ["d:1000"],
      ["d:1000"],
      ["d:1000"],
      ["d:400"],
    ]);
    expect(batches[3][0].start).toBe(700); // overlapping split keeps boundary text
  });

  it("keeps only catalogue codes with verbatim quotes and maps span refs to note offsets", () => {
    const batch = [
      { clinicalNoteId: "cn1", noteType: null, date: null, start: 1000, end: 1063, text: "Overnight JET treated with temporary pacing. No pneumothorax." },
      { clinicalNoteId: "cn2", noteType: null, date: null, start: 50, end: 80, text: "Reintubated for distress." },
    ];
    const r = validateScreen(
      screenSchema.parse({
        mentions: [
          { spanRef: "S1", code: "75", assertion: "affirmed", excerpt: "temporary pacing" },
          { spanRef: "S1", code: "190", assertion: "negated", excerpt: "No pneumothorax" },
          { spanRef: "S1", code: "999", assertion: "affirmed", excerpt: "JET" },
          { spanRef: "S1", code: "72", assertion: "possible", excerpt: "not in the text" },
          { spanRef: "S1", code: "160", assertion: "affirmed", excerpt: "Reintubated" }, // wrong span id, verbatim in S2
        ],
      }),
      batch,
      new Set(["75", "190", "72", "160"]),
    );
    expect(r.map((m) => [m.code, m.clinicalNoteId])).toEqual([
      ["75", "cn1"],
      ["190", "cn1"],
      ["160", "cn2"],
    ]);
    expect(r[0].start).toBe(1000 + batch[0].text.indexOf("temporary pacing"));
    expect(r[2].start).toBe(50);
  });
});

describe("mapPool", () => {
  it("bounds concurrency, preserves order and stops scheduling on request", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return x * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
    let started = 0;
    const partial = await mapPool(
      [1, 2, 3, 4],
      1,
      async (x) => (started++, x),
      () => started >= 2,
    );
    expect(partial).toEqual([1, 2, undefined, undefined]);
  });
});
describe("excerpt location and cost", () => {
  it("tolerates whitespace/case/quote marks but rejects paraphrase", () => {
    expect(locateExcerpt("New right\n pneumothorax noted", "“new RIGHT pneumothorax”")).toEqual({ start: 0, end: 23 });
    expect(locateExcerpt("New right pneumothorax", "collapsed lung")).toBeNull();
  });
  it("computes cost only from configured prices", () => {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000, reasoningTokens: 0 };
    expect(computeCost("m", usage, { m: { inputPer1M: 1, cachedInputPer1M: 0.1, outputPer1M: 4 } })).toBeCloseTo(0.8 + 0.02 + 0.4);
    expect(computeCost("unknown", usage, {})).toBeNull();
  });
});
