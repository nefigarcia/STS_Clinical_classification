import { describe, expect, it } from "vitest";
import { segmentNote } from "@/lib/clinical/segmenter";
import { assertionAt } from "@/lib/clinical/assertion";
import { findTermHits, keywordRegex } from "@/lib/clinical/lexicon";
import { mapHistoricalEvidence } from "@/lib/data/evidence-mapper";
import { prepareEncounterPassages } from "@/lib/ai/candidate-detection";

describe("segmentNote", () => {
  const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} describes the postoperative course in detail.`).join(" ") + "\n\nASSESSMENT: stable.";
  const parts = segmentNote(text, 500, 100);
  it("splits long notes into bounded passages whose offsets index the original text", () => {
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) {
      expect(p.text.length).toBeLessThanOrEqual(500);
      expect(text.slice(p.start, p.end)).toBe(p.text);
    }
  });
  it("covers the whole note with overlap so boundary evidence is not lost", () => {
    expect(parts[0].start).toBe(0);
    expect(parts[parts.length - 1].end).toBe(text.length);
    for (let i = 1; i < parts.length; i++) expect(parts[i].start).toBeLessThan(parts[i - 1].end);
  });
  it("returns short notes unchanged", () => {
    expect(segmentNote("short", 500, 50)).toEqual([{ start: 0, end: 5, text: "short" }]);
  });
});

describe("assertion detection", () => {
  const at = (s: string, term: string) => assertionAt(s, s.toLowerCase().indexOf(term));
  it("distinguishes affirmed, negated, historical and hypothetical mentions", () => {
    expect(at("New right pneumothorax on CXR.", "pneumothorax")).toBe("affirmed");
    expect(at("No pneumothorax on today's film.", "pneumothorax")).toBe("negated");
    expect(at("Denies seizure activity.", "seizure")).toBe("negated");
    expect(at("History of seizures in infancy.", "seizure")).toBe("historical");
    expect(at("Plan for cardiac catheterization next week.", "cath")).toBe("hypothetical");
    expect(at("Pneumothorax: none.", "pneumothorax")).toBe("negated");
  });
  it("stops negation scope at terminators", () => {
    expect(at("No fever. Pneumothorax noted on CXR.", "pneumothorax")).toBe("affirmed");
    expect(at("No fever but pneumothorax noted.", "pneumothorax")).toBe("affirmed");
  });
});

describe("lexicon and keyword search", () => {
  it("finds candidate terms (search guidance only)", () => {
    const hits = findTermHits("Junctional ectopic tachycardia; temporary pacing started. Reintubated at 06:10.");
    expect(hits.map((h) => h.category)).toEqual(expect.arrayContaining(["arrhythmia", "reintubation"]));
  });
  it("builds keyword regex from the Key Words column", () => {
    const re = keywordRegex("JET, temporary  pacing; chest tube")!;
    expect("temporary pacing".match(re)).toBeTruthy();
    expect(keywordRegex("a, b")).toBeNull();
  });
});

describe("historical evidence mapping", () => {
  const note = (id: string, text: string, type = "ICU Progress Note") => ({ id: `cn-${id}`, noteId: id, noteType: type, combinedNoteText: text });
  it("never auto-verifies; affirmed evidence is pending clinician verification", () => {
    const r = mapHistoricalEvidence("Pneumothorax", "pneumothorax, chest tube", "ICU Progress Note", [note("1", "New right pneumothorax; chest tube placed.")]);
    expect(r.quality).toBe("PENDING_VERIFICATION");
    expect(r.supportingNoteIds).toEqual(["1"]);
  });
  it("flags only-negated mentions as conflicting", () => {
    const r = mapHistoricalEvidence("Pleural effusion", "pleural effusion", null, [note("2", "No evidence of pleural effusion.")]);
    expect(r.quality).toBe("CONFLICTING_EVIDENCE");
  });
  it("does not label every note in the encounter positive", () => {
    const r = mapHistoricalEvidence("Chylothorax", "chylothorax", null, [note("3", "Chylothorax confirmed."), note("4", "Routine nutrition note.")]);
    expect(r.supportingNoteIds).toEqual(["3"]);
    expect(r.candidateNoteIds).toEqual(["3", "4"]);
  });
  it("reports insufficient evidence when nothing matches", () => {
    expect(mapHistoricalEvidence("Seizure", "seizure", null, [note("5", "Routine day.")]).quality).toBe("INSUFFICIENT_EVIDENCE");
    expect(mapHistoricalEvidence("Seizure", null, null, []).quality).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("encounter passage preparation", () => {
  const n = (id: string, text: string, day: number, hash = id) => ({
    id: `c${id}`,
    noteId: id,
    noteType: "ICU Progress Note",
    dateOfService: new Date(Date.UTC(2026, 0, day)),
    combinedNoteText: text,
    contentHash: hash,
  });
  it("removes exact duplicates, keeps chronology and labels passages", () => {
    const r = prepareEncounterPassages([n("2", "Chylothorax on octreotide.", 3), n("1", "New pneumothorax.", 2), n("1b", "New pneumothorax.", 2, "1")], {
      passageChars: 1500,
      passageOverlap: 200,
      maxPassages: 10,
    });
    expect(r.duplicateNotesRemoved).toBe(1);
    expect(r.passages.map((p) => p.noteId)).toEqual(["1", "2"]);
    expect(r.passages[0].label).toBe("P1");
    expect(r.categories).toEqual(expect.arrayContaining(["pneumothorax", "chylothorax"]));
  });
  it("sends nothing when no candidate terms exist", () => {
    expect(prepareEncounterPassages([n("1", "Routine care.", 1)], { passageChars: 1500, passageOverlap: 200, maxPassages: 10 }).passages).toEqual([]);
  });
});
