/**
 * Lightweight NegEx-style assertion classifier used to pre-screen keyword hits.
 * It only prioritizes passages for the model and flags conflicts; it never decides
 * whether a complication occurred.
 */
export type Assertion = "affirmed" | "negated" | "historical" | "hypothetical";

const NEGATION = [
  /\bno\b/,
  /\bnot\b/,
  /\bdenies\b/,
  /\bwithout\b/,
  /\bnegative for\b/,
  /\bruled? out\b/,
  /\br\/o\b/,
  /\bfree of\b/,
  /\babsence of\b/,
  /\bno evidence of\b/,
  /\bno signs? of\b/,
  /\bunlikely\b/,
];
const HISTORICAL = [/\bhistory of\b/, /\bh\/o\b/, /\bprior\b/, /\bprevious(ly)?\b/, /\bremote\b/, /\bpmh\b/];
const HYPOTHETICAL = [
  /\bif\b/,
  /\bplan(ned)? (for|to)\b/,
  /\bwill\b/,
  /\bscheduled\b/,
  /\bconsider(ing)?\b/,
  /\bmonitor for\b/,
  /\brisk of\b/,
  /\bconcern for\b/,
  /\bpossible\b/,
  /\bto be\b/,
];
// Terms that stop a cue from reaching the target (e.g. "no fever but pneumothorax").
const TERMINATORS = /\b(but|however|although|except|though|which|now|currently)\b|[.;:\n]/g;

export function assertionAt(text: string, matchIndex: number, window = 70): Assertion {
  let start = Math.max(0, matchIndex - window);
  const before = text.slice(start, matchIndex).toLowerCase();
  // Only consider cues after the last terminator in the window.
  let lastTerm = -1;
  for (const m of before.matchAll(TERMINATORS)) lastTerm = m.index! + m[0].length;
  const scope = lastTerm >= 0 ? before.slice(lastTerm) : before;
  start += lastTerm >= 0 ? lastTerm : 0;
  if (NEGATION.some((re) => re.test(scope))) return "negated";
  if (HISTORICAL.some((re) => re.test(scope))) return "historical";
  if (HYPOTHETICAL.some((re) => re.test(scope))) return "hypothetical";
  // Post-cue negation: "pneumothorax: none", "pneumothorax was not seen", "pneumothorax resolved"
  const after = text.slice(matchIndex, matchIndex + 60).toLowerCase();
  if (/^[\w\s-]{0,30}(:\s*(none|no|negative)|\b(was|is) not\b|\bruled out\b|\bnot seen\b)/.test(after)) return "negated";
  return "affirmed";
}
