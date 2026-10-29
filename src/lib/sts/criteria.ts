/**
 * Turns one STS postoperative-event definition (Defined / Timeframe / Code this Event /
 * exclusions) into a checklist the model must answer criterion by criterion. The final
 * decision is computed from the answers in code (see ai/adjudication.ts), never taken
 * from a free-form model verdict.
 */

export type TimeframeClasses = { intraoperative: boolean; major: boolean; other: boolean; raw: string | null };

export type Criterion = {
  id: string; // D1 = Defined, C1 = Code this Event, E1..En = exclusions
  kind: "defined" | "code_this_event" | "exclusion";
  text: string;
};

export type CodeChecklist = {
  code: string;
  name: string;
  timeframe: TimeframeClasses;
  criteria: Criterion[];
  fullDefinition: string;
};

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseTimeframeClasses(definition: string): TimeframeClasses {
  const m = definition.match(/Timeframe:\s*([\s\S]*?)(?:\n\s*See General Information|\n[A-Z][A-Za-z /]{2,30}:|$)/);
  const raw = m ? oneLine(m[1]) : null;
  const t = (raw ?? "").toLowerCase();
  return {
    intraoperative: /intra/.test(t),
    major: /\bmajor\b/.test(t),
    // "Other postop event", "Other event", "(minor)"
    other: /\bother\b|minor/.test(t),
    raw,
  };
}

/** Section of the definition starting at `label:` up to the next known top-level label. */
function section(definition: string, label: RegExp): string | null {
  const start = definition.search(label);
  if (start < 0) return null;
  const rest = definition.slice(start);
  const body = rest.replace(label, "");
  const end = body.search(/\n\s*(?:Defined|Timeframe|Code this Event|References)\s*:/);
  return (end >= 0 ? body.slice(0, end) : body).trim();
}

const EXCLUSION =
  /\b(do not (?:code|include)|does not include|not considered|are not (?:considered|unplanned)|is not (?:considered|coded)|should not be coded|exclude[sd]?)\b/i;

/**
 * Split the "Code this Event" paragraph into sentences, attaching bullet lists to the sentence that
 * introduces them, and pull exclusion statements out as their own criteria.
 */
export function splitStatements(text: string): string[] {
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const blocks: string[] = [];
  let cur = "";
  for (const l of lines) {
    if (/^[•\-–]\s*/.test(l)) {
      cur += `\n${l}`;
      continue;
    }
    const last = cur.split("\n").pop() ?? "";
    const afterBullet = /^[•\-–]/.test(last);
    // Continuation of a wrapped line (also wrapped bullet text) vs. start of a new sentence.
    const continues = cur && !/[.:]$/.test(last) && (!afterBullet || /^[a-z(]/.test(l));
    if (continues) cur += ` ${l}`;
    else {
      if (cur) blocks.push(cur);
      cur = l;
    }
  }
  if (cur) blocks.push(cur);
  // Further split prose blocks on sentence boundaries (keeping bullet lists attached).
  return blocks
    .flatMap((b) => (b.includes("\n") ? [b] : b.split(/(?<=\.)\s+(?=[A-Z])/)))
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

export function buildChecklist(code: string, name: string, definition: string): CodeChecklist {
  const defined = section(definition, /Defined\s*:/);
  const codeThis = section(definition, /Code this Event\s*:/);
  const criteria: Criterion[] = [];
  if (defined) criteria.push({ id: "D1", kind: "defined", text: oneLine(defined) });
  const statements = codeThis ? splitStatements(codeThis) : [];
  const inclusion = statements.filter((s) => !EXCLUSION.test(s));
  const exclusions = statements.filter((s) => EXCLUSION.test(s));
  if (inclusion.length) criteria.push({ id: "C1", kind: "code_this_event", text: inclusion.join("\n") });
  exclusions.forEach((s, i) => criteria.push({ id: `E${i + 1}`, kind: "exclusion", text: s }));
  return { code, name, timeframe: parseTimeframeClasses(definition), criteria, fullDefinition: definition };
}

/** Codes that are not complications to detect (no-event marker, free-text "other"). */
export function isScreenableCode(code: string, name: string): boolean {
  return !/^no intra or post/i.test(name) && !/^other\b/i.test(name);
}
