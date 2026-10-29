/**
 * Semantic chunker for the STS CHSD Training Manual (layout verified against v6.23.2).
 *
 * Each data field is a labelled block:
 *   Long Name / SeqNo / Short Name / Database Table Name / Data Source / Format /
 *   Definition / Low-High Value / ParentLongName / ParentShortName / ParentHarvestCodes /
 *   ParentValue / Harvest Codes and Display Conditions ("Code: Value (Display Condition):") /
 *   Intent/Clarification / optional per-code table ("Code: Value: Definition:").
 *
 * - A field block becomes one rule, so a definition stays with its clarification.
 *   Oversized blocks are split with the field header repeated on every piece.
 * - Every coded value of a complication/event field becomes its own code-level rule
 *   carrying that code's own definition text (Defined / Timeframe / Code this Event…).
 * - Text outside field blocks ("General Information …" pages) is chunked by section.
 */

export type ParsedRule = {
  sectionName: string | null;
  pageNumber: number;
  pageEnd: number;
  longName: string | null;
  shortName: string | null;
  seqNumber: string | null;
  dbTable: string | null;
  stsCode: string | null;
  complicationName: string | null;
  definition: string | null;
  intentClarification: string | null;
  codingInstructions: string | null;
  validCodes: { code: string; value: string }[];
  parentConditions: string | null;
  inclusionExclusion: string | null;
  specialNotes: string | null;
  chunkText: string;
  isComplicationRule: boolean;
};

type FieldKey =
  | "longName"
  | "seqNumber"
  | "shortName"
  | "dbTable"
  | "codingInstructions"
  | "definition"
  | "parentConditions"
  | "harvest"
  | "codeTable"
  | "intentClarification"
  | "specialNotes";

const LABELS: { key: FieldKey; re: RegExp }[] = [
  { key: "longName", re: /^\s*long\s*name\s*:/i },
  { key: "seqNumber", re: /^\s*seq(?:uence)?\.?\s*(?:#|no\.?|number)\s*:?/i },
  { key: "shortName", re: /^\s*short\s*name\s*:/i },
  { key: "dbTable", re: /^\s*(?:database\s+)?table(?:\s+name)?\s*:/i },
  { key: "codingInstructions", re: /^\s*(?:data\s+source|format|low\s+value|high\s+value|usual\s+range(?:\s+\w+)?|core|harvest)\s*:/i },
  { key: "definition", re: /^\s*definition\s*:/i },
  { key: "parentConditions", re: /^\s*parent\s*(?:long\s*name|short\s*name|harvest\s*codes|value)\s*:/i },
  { key: "harvest", re: /^\s*(?:harvest\s+codes(?:\s+and\s+display\s+conditions)?\s*:|code\s*:\s*value\s*(?:\(display condition\))?\s*:\s*$)/i },
  { key: "codeTable", re: /^\s*code\s*:\s*value\s*:\s*definition\s*:/i },
  { key: "intentClarification", re: /^\s*intent\s*\/?\s*clarification\s*:?/i },
  { key: "specialNotes", re: /^\s*(?:note|notes|special\s+note|example)s?\s*:/i },
];

/** Keys whose label line should be kept verbatim (multi-line keys append, single-line keys take the remainder). */
const KEEP_LABEL: FieldKey[] = ["codingInstructions", "parentConditions"];

const PAGE_FURNITURE = [
  /^\s*chsd training manual\s*-\s*version\s+[\d.]+\s+page\s+\d+\s+of\s+\d+\s*$/i,
  /^\s*page\s+\d+\s*(of\s+\d+)?\s*$/i,
  /^\s*\d+\s*$/,
  /^\s*©.*society of thoracic surgeons.*$/i,
];

function cleanLines(page: string): string[] {
  return page
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/g, ""))
    .filter((l) => l.trim() && !PAGE_FURNITURE.some((re) => re.test(l)));
}

/** Section headings: "S2. POSTOPERATIVE EVENTS", all-caps titles, "General Information …". */
function isHeading(line: string, inBlock: boolean): boolean {
  const t = line.trim();
  if (/^general information\b/i.test(t) && t.length < 120) return true;
  if (t.length < 4 || t.length > 90 || /[:.;,]$/.test(t)) return false;
  if (/^(section|chapter|part)\s+[\dIVXA-Z]+/i.test(t)) return true;
  if (/^[A-Z]\d{0,2}\.\s+[A-Z]/.test(t) && t === t.toUpperCase()) return true;
  // Inside a field block only the explicit patterns above end the field: wrapped code values such as
  // "(MODS)" or "VAD, ECMO" are all-caps but are not headings.
  if (inBlock) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  return !/[()\d]/.test(t) && t.split(/\s+/).length >= 2 && letters.length >= 6 && letters === letters.toUpperCase();
}

const COMPLICATION_HINT = /complication|postoperative event|post-?op(erative)? event|adverse event|unplanned|reoperation|cardiac arrest/i;
const CODE_ENTRY = /^\s*(\d{1,4})\s+(\S.*)$/;

/** Parse a harvest-code list: "17 No intra or post operative events (…)" with wrapped continuation lines. */
export function extractCodes(text: string): { code: string; value: string }[] {
  const out: { code: string; value: string }[] = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cv = line.match(/^code\s*:\s*([\w.-]{1,12})\s+value\s*:\s*(.+)$/i) ?? line.match(/^([0-9]{1,5}(?:\.[0-9]+)?)\s*[=–—-]\s*(.{3,})$/);
    const m = cv ?? line.match(CODE_ENTRY);
    if (m) out.push({ code: m[1].trim(), value: m[2].trim() });
    else if (out.length) out[out.length - 1].value = `${out[out.length - 1].value} ${line}`.trim();
  }
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.code) ? false : (seen.add(c.code), true)));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Split the per-code "Code: Value: Definition:" table into entries. An entry starts at a line
 * "<code> <text>" only when <code> is one of the field's harvest codes AND <text> begins like
 * that code's value — so numbers inside definition prose ("30 days…") are not mistaken for entries.
 */
function parseCodeTable(lines: Line[], codes: Map<string, string>) {
  const entries: { code: string; page: number; lines: string[] }[] = [];
  for (const l of lines) {
    const m = l.text.match(CODE_ENTRY);
    const value = m ? codes.get(m[1]) : undefined;
    let starts = false;
    if (m && value !== undefined) {
      const [a, b] = [norm(value), norm(m[2])];
      const k = Math.min(8, a.length, b.length);
      starts = k > 0 && a.slice(0, k) === b.slice(0, k);
    }
    if (starts) entries.push({ code: m![1], page: l.page, lines: [m![2].trim()] });
    else if (entries.length && !LABELS.find((x) => x.key === "codeTable")!.re.test(l.text)) entries[entries.length - 1].lines.push(l.text.trim());
  }
  // Drop the wrapped value text (everything before "Defined:", which may share a line with the value).
  return entries.map((e) => {
    const joined = e.lines.join("\n");
    const at = joined.search(/\b(Defined|Definition)\s*:/);
    return { code: e.code, page: e.page, definition: (at >= 0 ? joined.slice(at) : "").trim() };
  });
}

type Line = { text: string; page: number };

function emptyRule(section: string | null, page: number, pageEnd: number, chunkText: string, isComplicationRule: boolean): ParsedRule {
  return {
    sectionName: section,
    pageNumber: page,
    pageEnd,
    longName: null,
    shortName: null,
    seqNumber: null,
    dbTable: null,
    stsCode: null,
    complicationName: null,
    definition: null,
    intentClarification: null,
    codingInstructions: null,
    validCodes: [],
    parentConditions: null,
    inclusionExclusion: null,
    specialNotes: null,
    chunkText,
    isComplicationRule,
  };
}

function blockToRules(lines: Line[], section: string | null, maxChars: number): ParsedRule[] {
  const fields: Partial<Record<FieldKey, Line[]>> = {};
  let current: FieldKey | null = null;
  for (const line of lines) {
    let label = LABELS.find((l) => l.re.test(line.text));
    // Inside the per-code table, "Note:" / "Definition:" lines are part of an entry, not new fields.
    if (current === "codeTable" && label && label.key !== "codeTable" && label.key !== "intentClarification") label = undefined;
    if (label) {
      current = label.key;
      const rest = KEEP_LABEL.includes(label.key) ? line.text.trim() : line.text.replace(label.re, "").trim();
      if (rest) (fields[current] ??= []).push({ ...line, text: rest });
      else fields[current] ??= [];
    } else if (current) {
      (fields[current] ??= []).push(line);
    }
  }
  const text = (k: FieldKey) => {
    const v = fields[k]
      ?.map((l) => l.text)
      .join("\n")
      .trim();
    return v ? v : null;
  };
  const longName = text("longName")?.split("\n")[0] ?? null;
  const shortName = text("shortName")?.split("\n")[0] ?? null;
  const seqNumber = text("seqNumber")?.split(/\s/)[0] ?? null;
  const validCodes = extractCodes(text("harvest") ?? "");
  const intent = text("intentClarification");
  const isComplicationRule = COMPLICATION_HINT.test(`${section ?? ""} ${longName ?? ""}`);
  const header = `[${section ?? ""}] Long Name: ${longName ?? ""} | Short Name: ${shortName ?? ""} | SeqNo: ${seqNumber ?? ""}`;

  // Field-level rule: everything except the per-code definition table (those become code rules).
  const fieldText = lines
    .filter((l) => !(fields.codeTable ?? []).includes(l))
    .map((l) => l.text)
    .join("\n");
  const base: ParsedRule = {
    ...emptyRule(section, lines[0].page, lines[lines.length - 1].page, "", isComplicationRule),
    longName,
    shortName,
    seqNumber,
    dbTable: text("dbTable")?.split("\n")[0] ?? null,
    definition: text("definition"),
    intentClarification: intent,
    codingInstructions: text("codingInstructions"),
    validCodes,
    parentConditions: text("parentConditions"),
    inclusionExclusion: intent?.match(/(?:^|\n).*\b(do not code|code only|exclude|include)\b.*/gi)?.join("\n") ?? null,
    specialNotes: text("specialNotes"),
  };
  const rules: ParsedRule[] = [];
  const full = (section ? `[${section}]\n` : "") + fieldText;
  if (full.length <= maxChars) rules.push({ ...base, chunkText: full });
  else {
    const step = maxChars - header.length - 20;
    for (let i = 0; i < fieldText.length; i += step) {
      rules.push({ ...base, chunkText: `${header}${i === 0 ? "" : " (continued)"}\n${fieldText.slice(i, i + step)}` });
    }
  }

  // Code-level rules for event/complication fields, each with its own definition when the manual provides one.
  if (isComplicationRule && validCodes.length) {
    const table = parseCodeTable(fields.codeTable ?? [], new Map(validCodes.map((c) => [c.code, c.value])));
    const defs = new Map(table.map((t) => [t.code, t]));
    for (const c of validCodes) {
      const d = defs.get(c.code);
      const body = d?.definition ?? "";
      rules.push({
        ...base,
        pageNumber: d?.page ?? base.pageNumber,
        pageEnd: d?.page ?? base.pageEnd,
        stsCode: c.code,
        complicationName: c.value.replace(/\s*\(AgeDays[^)]*\)\s*$/i, "").trim(),
        definition: body || base.definition,
        intentClarification: null,
        chunkText: `${header}\nCode ${c.code}: ${c.value}\n${body ? `Event definition:\n${body}` : `Field definition: ${base.definition ?? ""}`}`.slice(
          0,
          maxChars,
        ),
      });
    }
  }
  return rules;
}

/**
 * Convert per-page text into semantic rule chunks. Field blocks start at a "Long Name:" line and run
 * to the next field or a new section heading. Loose text is chunked per section.
 */
export function parseManual(pages: string[], opts: { maxChars?: number } = {}): ParsedRule[] {
  const maxChars = opts.maxChars ?? 8000;
  const lines: Line[] = pages.flatMap((p, i) => cleanLines(p).map((text) => ({ text, page: i + 1 })));
  const rules: ParsedRule[] = [];
  let section: string | null = null;
  let block: Line[] = [];
  let loose: Line[] = [];
  let blockSection: string | null = null;

  const flushLoose = () => {
    const text = loose.map((l) => l.text).join("\n");
    if (text.length > 120) {
      for (let i = 0; i < text.length; i += maxChars) {
        const slice = text.slice(i, i + maxChars);
        rules.push(
          emptyRule(
            section,
            loose[0].page,
            loose[loose.length - 1].page,
            (section ? `[${section}]\n` : "") + slice,
            COMPLICATION_HINT.test(`${section ?? ""} ${slice.slice(0, 400)}`),
          ),
        );
      }
    }
    loose = [];
  };
  const flushBlock = () => {
    if (block.length) rules.push(...blockToRules(block, blockSection, maxChars));
    block = [];
  };

  for (const line of lines) {
    if (/^\s*long\s*name\s*:/i.test(line.text)) {
      flushBlock();
      flushLoose();
      blockSection = section;
      block.push(line);
      continue;
    }
    if (isHeading(line.text, block.length > 0)) {
      flushBlock();
      flushLoose();
      section = line.text.trim();
      continue;
    }
    if (block.length) block.push(line);
    else loose.push(line);
  }
  flushBlock();
  flushLoose();
  return rules;
}
