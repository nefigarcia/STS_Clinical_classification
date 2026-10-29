/**
 * Locate a quoted excerpt inside source text, tolerant only of whitespace and case differences
 * (and surrounding quote marks). Returns offsets into `text` shifted by `offset`, or null when the
 * quote is not verbatim — paraphrases never verify.
 */
export function locateExcerpt(text: string, excerpt: string, offset = 0): { start: number; end: number } | null {
  const target = excerpt
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (target.length < 4) return null;
  const map: number[] = [];
  let squashed = "";
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!lastSpace) {
        squashed += " ";
        map.push(i);
      }
      lastSpace = true;
    } else {
      squashed += ch.toLowerCase();
      map.push(i);
      lastSpace = false;
    }
  }
  const idx = squashed.indexOf(target);
  if (idx < 0) return null;
  return { start: offset + map[idx], end: offset + map[idx + target.length - 1] + 1 };
}
