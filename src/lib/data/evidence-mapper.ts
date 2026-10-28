import type { ClinicalNote, ExampleQuality } from "@prisma/client";
import { assertionAt, type Assertion } from "@/lib/clinical/assertion";
import { findTermHits, keywordRegex } from "@/lib/clinical/lexicon";

export type EvidenceCandidate = {
  noteId: string;
  clinicalNoteId: string;
  noteType: string | null;
  excerpt: string;
  start: number;
  end: number;
  term: string;
  assertion: Assertion;
  source: "keyword" | "lexicon";
};

export type MappingOutcome = {
  quality: ExampleQuality;
  reason: string;
  candidates: EvidenceCandidate[];
  supportingNoteIds: string[];
  candidateNoteIds: string[];
};

function excerptAround(text: string, idx: number, len: number, radius = 160) {
  const start = Math.max(0, text.lastIndexOf(" ", Math.max(0, idx - radius)) + 1);
  let end = text.indexOf(" ", Math.min(text.length, idx + len + radius));
  if (end === -1) end = text.length;
  return { start, end, excerpt: text.slice(start, end).replace(/\s+/g, " ").trim() };
}

/** Lexicon categories whose name overlaps the label, e.g. "Pleural effusion" -> "pleural effusion". */
function lexiconCategoriesFor(label: string): string[] {
  const l = label.toLowerCase();
  const map: [RegExp, string][] = [
    [/arrest/, "cardiac arrest"],
    [/reoperation|re-?op/, "unplanned reoperation"],
    [/cath|intervention/, "unplanned interventional catheterization"],
    [/seizure/, "seizure"],
    [/pneumothorax/, "pneumothorax"],
    [/reintubat/, "reintubation"],
    [/arrhythm|pacer|pacing|heart block/, "arrhythmia"],
    [/chylo/, "chylothorax"],
    [/pleural effusion/, "pleural effusion"],
  ];
  return map.filter(([re]) => re.test(l)).map(([, c]) => c);
}

/**
 * Locate candidate evidence for a historical label among candidate notes using the
 * reviewer-provided Key Words / Note Info and clinical vocabulary. Never returns VERIFIED:
 * verification is always a human decision.
 */
export function mapHistoricalEvidence(
  label: string,
  keyWords: string | null,
  noteInfo: string | null,
  notes: Pick<ClinicalNote, "id" | "noteId" | "noteType" | "combinedNoteText">[],
): MappingOutcome {
  if (notes.length === 0) {
    return {
      quality: "INSUFFICIENT_EVIDENCE",
      reason: "No candidate notes on the Date of Service",
      candidates: [],
      supportingNoteIds: [],
      candidateNoteIds: [],
    };
  }
  const kw = keywordRegex([keyWords, label].filter(Boolean).join(","));
  const cats = new Set(lexiconCategoriesFor(label));
  const candidates: EvidenceCandidate[] = [];
  for (const n of notes) {
    const text = n.combinedNoteText;
    const seen = new Set<number>();
    if (kw) {
      kw.lastIndex = 0;
      for (const m of text.matchAll(kw)) {
        const bucket = Math.floor(m.index! / 200);
        if (seen.has(bucket)) continue;
        seen.add(bucket);
        const ex = excerptAround(text, m.index!, m[0].length);
        candidates.push({
          noteId: n.noteId,
          clinicalNoteId: n.id,
          noteType: n.noteType,
          ...ex,
          term: m[0],
          assertion: assertionAt(text, m.index!),
          source: "keyword",
        });
      }
    }
    for (const h of findTermHits(text)) {
      if (!cats.has(h.category)) continue;
      const bucket = Math.floor(h.index / 200);
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      const ex = excerptAround(text, h.index, h.term.length);
      candidates.push({
        noteId: n.noteId,
        clinicalNoteId: n.id,
        noteType: n.noteType,
        ...ex,
        term: h.term,
        assertion: assertionAt(text, h.index),
        source: "lexicon",
      });
    }
  }
  // Note Info is free text describing where the evidence is (e.g. note type); boost matching notes.
  const info = (noteInfo ?? "").toLowerCase();
  candidates.sort((a, b) => {
    const ai = a.noteType && info.includes(a.noteType.toLowerCase()) ? 1 : 0;
    const bi = b.noteType && info.includes(b.noteType.toLowerCase()) ? 1 : 0;
    return bi - ai || (a.assertion === "affirmed" ? -1 : 1) - (b.assertion === "affirmed" ? -1 : 1);
  });
  const affirmed = candidates.filter((c) => c.assertion === "affirmed");
  const negated = candidates.filter((c) => c.assertion === "negated");
  const supportingNoteIds = [...new Set(affirmed.map((c) => c.noteId))];
  const candidateNoteIds = [...new Set(notes.map((n) => n.noteId))];
  if (affirmed.length === 0 && negated.length > 0) {
    return {
      quality: "CONFLICTING_EVIDENCE",
      reason: "Only negated mentions found in candidate notes",
      candidates: candidates.slice(0, 12),
      supportingNoteIds: [],
      candidateNoteIds,
    };
  }
  if (affirmed.length === 0) {
    return {
      quality: "INSUFFICIENT_EVIDENCE",
      reason: "No mention of the label or key words in candidate notes",
      candidates: candidates.slice(0, 12),
      supportingNoteIds: [],
      candidateNoteIds,
    };
  }
  const conflicting = negated.length > affirmed.length;
  return {
    quality: conflicting ? "CONFLICTING_EVIDENCE" : "PENDING_VERIFICATION",
    reason: conflicting
      ? `More negated (${negated.length}) than affirmed (${affirmed.length}) mentions; clinical review required`
      : `${affirmed.length} affirmed candidate mention(s) in ${supportingNoteIds.length} note(s); awaiting clinician verification`,
    candidates: candidates.slice(0, 12),
    supportingNoteIds,
    candidateNoteIds,
  };
}
