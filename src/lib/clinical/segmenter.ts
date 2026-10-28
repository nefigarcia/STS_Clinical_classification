export type Passage = { start: number; end: number; text: string };

/**
 * Split a note into passages on semantic boundaries (blank lines, section headers,
 * sentence ends), packing pieces up to maxChars with a character overlap so evidence
 * near a boundary is never lost. Offsets index into the original string.
 */
export function segmentNote(text: string, maxChars = 1500, overlap = 200): Passage[] {
  if (text.length <= maxChars) return [{ start: 0, end: text.length, text }];
  // Candidate cut points: paragraph breaks, header-like lines, then sentence ends.
  const cuts = new Set<number>();
  for (const re of [/\n\s*\n/g, /\n(?=[A-Z][A-Za-z /&()-]{2,60}:)/g, /[.!?]\s+(?=[A-Z])/g, /\n/g]) {
    for (const m of text.matchAll(re)) cuts.add(m.index! + m[0].length);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const passages: Passage[] = [];
  let start = 0;
  while (start < text.length) {
    const limit = start + maxChars;
    if (limit >= text.length) {
      passages.push({ start, end: text.length, text: text.slice(start) });
      break;
    }
    // Prefer the last semantic cut within the window, but not too early.
    let end = -1;
    for (const p of points) {
      if (p <= start + maxChars * 0.5) continue;
      if (p > limit) break;
      end = p;
    }
    if (end === -1) end = limit; // hard cut for unbroken text
    passages.push({ start, end, text: text.slice(start, end) });
    const next = Math.max(end - overlap, start + 1);
    // Re-align the overlap start to a word boundary.
    const ws = text.slice(next, end).search(/\s/);
    start = ws >= 0 && next + ws < end ? next + ws + 1 : next;
  }
  return passages;
}
