/**
 * Semantic chunker for STS CHSD training-manual text.
 *
 * STS data-specification style manuals describe each data field as a labelled block
 * (Long Name, Short Name, Seq #, Table, Definition, Intent/Clarification, codes...).
 * Each field block becomes ONE rule so a definition is never separated from its
 * coding clarification. Text outside field blocks is chunked by section heading.
 *
 * The exact layout of manual v6.23 has not been verified against the real PDF;
 * parse statistics are shown to the administrator before the manual can be approved.
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

const LABELS: { key: keyof ParsedRule | "harvest"; re: RegExp }[] = [
  { key: "longName", re: /^\s*long\s*name\s*:/i },
  { key: "shortName", re: /^\s*short\s*name\s*:/i },
  { key: "seqNumber", re: /^\s*seq(?:uence)?\.?\s*(?:#|no\.?|number)\s*:?/i },
  { key: "dbTable", re: /^\s*(?:db\s*)?table\s*:/i },
  { key: "definition", re: /^\s*definition\s*:/i },
  { key: "intentClarification", re: /^\s*intent\s*\/?\s*clarification\s*:?/i },
  { key: "codingInstructions", re: /^\s*(?:coding\s+instructions?|data\s+source|harvest\s+codes?|field\s+type)\s*:/i },
  { key: "parentConditions", re: /^\s*parent\s*(?:long\s*name|short\s*name|value|field)?\s*:/i },
  { key: "inclusionExclusion", re: /^\s*(?:inclusions?|exclusions?|include|exclude|do not code|code only)\b.*:/i },
  { key: "specialNotes", re: /^\s*(?:note|notes|special\s+note|clarification|example)s?\s*:/i },
];

const PAGE_FURNITURE = [
  /^\s*page\s+\d+\s*(of\s+\d+)?\s*$/i,
  /^\s*\d+\s*$/,
  /^\s*©.*society of thoracic surgeons.*$/i,
  /^\s*sts\s+congenital heart surgery database.*training manual.*$/i,
];

function cleanLines(page: string): string[] {
  return page
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/g, ""))
    .filter((l) => l.trim() && !PAGE_FURNITURE.some((re) => re.test(l)));
}

function isHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 4 || t.length > 90 || /[:.;,]$/.test(t)) return false;
  if (/^(section|chapter|part)\s+[\dIVXA-Z]+/i.test(t)) return true;
  const letters = t.replace(/[^A-Za-z]/g, "");
  return letters.length >= 4 && letters === letters.toUpperCase();
}

const CODE_LINE = [/^\s*code\s*:\s*([\w.-]{1,12})\s+value\s*:\s*(.+)$/i, /^\s*([0-9]{1,5}(?:\.[0-9]+)?)\s*[=–—-]\s*(.{3,})$/, /^\s*([0-9]{1,5})\s{2,}(.{3,})$/];

export function extractCodes(text: string): { code: string; value: string }[] {
  const out: { code: string; value: string }[] = [];
  for (const line of text.split(/\n/)) {
    for (const re of CODE_LINE) {
      const m = line.match(re);
      if (m) {
        out.push({ code: m[1].trim(), value: m[2].trim() });
        break;
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.code) ? false : (seen.add(c.code), true)));
}

const COMPLICATION_HINT = /complication|postoperative event|post-?op(erative)? event|adverse event|unplanned|reoperation|cardiac arrest/i;

type Line = { text: string; page: number };

function blockToRule(lines: Line[], section: string | null, manualMaxChars: number): ParsedRule[] {
  const fields: Partial<Record<keyof ParsedRule, string[]>> = {};
  let current: keyof ParsedRule | null = null;
  for (const { text } of lines) {
    const label = LABELS.find((l) => l.re.test(text));
    if (label && label.key !== "harvest") {
      current = label.key as keyof ParsedRule;
      const rest = text.replace(label.re, "").trim();
      (fields[current] ??= []).push(rest);
    } else if (current) {
      (fields[current] ??= []).push(text.trim());
    }
  }
  const join = (k: keyof ParsedRule) => {
    const v = fields[k]?.join("\n").trim();
    return v ? v : null;
  };
  const fullText = lines.map((l) => l.text).join("\n");
  const validCodes = extractCodes(fullText);
  const longName = join("longName")?.split("\n")[0] ?? null;
  const base: ParsedRule = {
    sectionName: section,
    pageNumber: lines[0].page,
    pageEnd: lines[lines.length - 1].page,
    longName,
    shortName: join("shortName")?.split("\n")[0] ?? null,
    seqNumber: join("seqNumber")?.split(/\s/)[0] ?? null,
    dbTable: join("dbTable")?.split("\n")[0] ?? null,
    stsCode: null,
    complicationName: null,
    definition: join("definition"),
    intentClarification: join("intentClarification"),
    codingInstructions: join("codingInstructions"),
    validCodes,
    parentConditions: join("parentConditions"),
    inclusionExclusion: join("inclusionExclusion"),
    specialNotes: join("specialNotes"),
    chunkText: (section ? `[${section}]\n` : "") + fullText,
    isComplicationRule: COMPLICATION_HINT.test(`${section ?? ""} ${longName ?? ""}`) || COMPLICATION_HINT.test(fullText.slice(0, 600)),
  };
  if (base.chunkText.length <= manualMaxChars) return [base];
  // Oversized block: split, repeating the field header so each piece stays self-describing.
  const header = `[${section ?? ""}] Long Name: ${longName ?? ""} | Short Name: ${base.shortName ?? ""} | Seq #: ${base.seqNumber ?? ""} (continued)\n`;
  const pieces: ParsedRule[] = [];
  for (let i = 0; i < fullText.length; i += manualMaxChars - header.length) {
    pieces.push({ ...base, chunkText: (i === 0 ? "" : header) + fullText.slice(i, i + manualMaxChars - header.length) });
  }
  return pieces;
}

/**
 * Convert per-page text into semantic rule chunks.
 * - Field blocks start at a "Long Name:" line and run to the next one or a new section.
 * - Coded values inside a complication field become additional code-level rules
 *   (stsCode + complicationName) pointing at the same page, used for code validation.
 */
export function parseManual(pages: string[], opts: { maxChars?: number } = {}): ParsedRule[] {
  const maxChars = opts.maxChars ?? 8000;
  const lines: Line[] = pages.flatMap((p, i) => cleanLines(p).map((text) => ({ text, page: i + 1 })));
  const rules: ParsedRule[] = [];
  let section: string | null = null;
  let block: Line[] = [];
  let looseBlock: Line[] = [];
  let blockSection: string | null = null;

  const flushLoose = () => {
    if (looseBlock.length && looseBlock.map((l) => l.text).join(" ").length > 120) {
      const text = looseBlock.map((l) => l.text).join("\n");
      for (let i = 0; i < text.length; i += maxChars) {
        const slice = text.slice(i, i + maxChars);
        rules.push({
          sectionName: section,
          pageNumber: looseBlock[0].page,
          pageEnd: looseBlock[looseBlock.length - 1].page,
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
          chunkText: (section ? `[${section}]\n` : "") + slice,
          isComplicationRule: COMPLICATION_HINT.test(`${section ?? ""} ${slice.slice(0, 400)}`),
        });
      }
    }
    looseBlock = [];
  };
  const flushBlock = () => {
    if (block.length) rules.push(...blockToRule(block, blockSection, maxChars));
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
    if (isHeading(line.text)) {
      // Code-table headings inside a field block stay in the block; any other heading starts a new section.
      if (block.length && /\b(codes?|values?|harvest|options?|selections?|choices?)\b/i.test(line.text)) {
        block.push(line);
        continue;
      }
      flushBlock();
      flushLoose();
      section = line.text.trim();
      continue;
    }
    if (block.length) block.push(line);
    else looseBlock.push(line);
  }
  flushBlock();
  flushLoose();

  // Code-level rules for complication fields.
  const codeRules: ParsedRule[] = [];
  for (const r of rules) {
    if (!r.isComplicationRule || r.validCodes.length === 0 || r.stsCode) continue;
    for (const c of r.validCodes) {
      codeRules.push({
        ...r,
        stsCode: c.code,
        complicationName: c.value,
        chunkText:
          `[${r.sectionName ?? ""}] ${r.longName ?? ""} — Code ${c.code}: ${c.value}\nField definition: ${r.definition ?? ""}\nIntent/Clarification: ${r.intentClarification ?? ""}`.slice(
            0,
            maxChars,
          ),
      });
    }
  }
  return [...rules, ...codeRules];
}
