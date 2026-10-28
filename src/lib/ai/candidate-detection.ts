import { assertionAt, type Assertion } from "@/lib/clinical/assertion";
import { findTermHits } from "@/lib/clinical/lexicon";
import { segmentNote } from "@/lib/clinical/segmenter";

export type NoteForPrep = {
  id: string;
  noteId: string;
  noteType: string | null;
  dateOfService: Date | null;
  combinedNoteText: string;
  contentHash: string;
};

export type CandidatePassage = {
  label: string; // P1, P2 ... (the only handle the model sees)
  clinicalNoteId: string;
  noteId: string;
  noteType: string | null;
  dateOfService: string | null;
  start: number;
  end: number;
  text: string;
  hits: { category: string; term: string; assertion: Assertion }[];
  score: number;
};

const NOTE_TYPE_WEIGHT: [RegExp, number][] = [
  [/significant event|op note|brief op|procedure|cath/i, 2],
  [/discharge summary|transfer/i, 1.5],
  [/icu progress|progress/i, 1],
];

/**
 * Group an encounter's notes chronologically, drop exact duplicate texts, split long
 * notes into overlapping semantic passages and score passages by clinical-term hits.
 * Keyword hits only prioritize passages; they never establish an event.
 */
export function prepareEncounterPassages(notes: NoteForPrep[], opts: { passageChars: number; passageOverlap: number; maxPassages: number }) {
  const seen = new Set<string>();
  const unique = [...notes]
    .sort((a, b) => (a.dateOfService?.getTime() ?? 0) - (b.dateOfService?.getTime() ?? 0) || a.noteId.localeCompare(b.noteId))
    .filter((n) => (seen.has(n.contentHash) ? false : (seen.add(n.contentHash), true)));
  const all: Omit<CandidatePassage, "label">[] = [];
  for (const n of unique) {
    const typeWeight = NOTE_TYPE_WEIGHT.find(([re]) => re.test(n.noteType ?? ""))?.[1] ?? 0.8;
    for (const p of segmentNote(n.combinedNoteText, opts.passageChars, opts.passageOverlap)) {
      const hits = findTermHits(p.text).map((h) => ({ category: h.category, term: h.term, assertion: assertionAt(p.text, h.index) }));
      if (hits.length === 0) continue;
      const affirmed = hits.filter((h) => h.assertion === "affirmed").length;
      const categories = new Set(hits.map((h) => h.category)).size;
      all.push({
        clinicalNoteId: n.id,
        noteId: n.noteId,
        noteType: n.noteType,
        dateOfService: n.dateOfService ? n.dateOfService.toISOString().slice(0, 10) : null,
        start: p.start,
        end: p.end,
        text: p.text,
        hits,
        score: (affirmed * 1.0 + (hits.length - affirmed) * 0.4 + categories * 0.5) * typeWeight,
      });
    }
  }
  // Keep the best passages but guarantee coverage of every detected category.
  const byScore = [...all].sort((a, b) => b.score - a.score);
  const chosen = new Set<(typeof all)[number]>();
  const categories = new Set(all.flatMap((p) => p.hits.map((h) => h.category)));
  for (const c of categories) {
    const best = byScore.filter((p) => p.hits.some((h) => h.category === c)).slice(0, 3);
    best.forEach((p) => chosen.add(p));
  }
  for (const p of byScore) {
    if (chosen.size >= opts.maxPassages) break;
    chosen.add(p);
  }
  const passages: CandidatePassage[] = [...chosen]
    .slice(0, Math.max(opts.maxPassages, categories.size))
    .sort((a, b) => (a.dateOfService ?? "").localeCompare(b.dateOfService ?? "") || a.noteId.localeCompare(b.noteId) || a.start - b.start)
    .map((p, i) => ({ ...p, label: `P${i + 1}` }));
  return {
    uniqueNotes: unique,
    passages,
    categories: [...categories],
    totalCandidatePassages: all.length,
    duplicateNotesRemoved: notes.length - unique.length,
  };
}
