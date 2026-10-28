import { z } from "zod";

export const NOTE_FIELDS = {
  mrn: { label: "MRN", required: true, synonyms: ["mrn", "medical record number", "pat_mrn_id"] },
  csn: { label: "CSN", required: true, synonyms: ["csn", "pat_enc_csn_id", "encounter csn", "encounter"] },
  noteId: { label: "NOTE_ID", required: true, synonyms: ["note_id", "noteid", "note id"] },
  noteText: { label: "COMBINED_NOTE_TEXT", required: true, synonyms: ["combined_note_text", "note_text", "note text", "text"] },
  noteType: { label: "NOTE_TYPE", required: false, synonyms: ["note_type", "note type", "type"] },
  dateOfService: { label: "DATE_OF_SERVICE", required: true, synonyms: ["date_of_service", "date of service", "dos", "service date"] },
  filedDate: { label: "LST_FILED_INST", required: false, synonyms: ["lst_filed_inst", "filed date", "filed_date"] },
  flag: { label: "Flag Notes", required: false, synonyms: ["flag notes", "flag", "flag_notes"] },
} as const;

export const HISTORICAL_FIELDS = {
  mrn: { label: "MRN", required: true, synonyms: ["mrn"] },
  csn: { label: "CSN", required: true, synonyms: ["csn"] },
  dateOfService: { label: "Date of Service", required: true, synonyms: ["date of service", "date_of_service", "dos"] },
  complication: { label: "Complication", required: true, synonyms: ["complication", "label", "expected complication"] },
  noteInfo: { label: "Note Info", required: false, synonyms: ["note info", "note_info"] },
  keyWords: { label: "Key Words", required: false, synonyms: ["key words", "keywords", "key_words"] },
  additionalInfo: { label: "Additional info", required: false, synonyms: ["additional info", "additional_info", "comments"] },
} as const;

export type NoteField = keyof typeof NOTE_FIELDS;
export type HistoricalField = keyof typeof HISTORICAL_FIELDS;
export type ImportKind = "CLINICAL_NOTES" | "HISTORICAL_COMPLICATIONS";

export const mappingSchema = z.record(z.string(), z.string().nullable());
export type ColumnMapping = Record<string, string | null>;

export function fieldsFor(kind: ImportKind) {
  return kind === "CLINICAL_NOTES" ? NOTE_FIELDS : HISTORICAL_FIELDS;
}

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, " ");

/** Suggest a mapping from canonical field -> source header using exact and synonym matches. */
export function suggestMapping(kind: ImportKind, headers: string[]): ColumnMapping {
  const fields = fieldsFor(kind);
  const mapping: ColumnMapping = {};
  for (const [key, def] of Object.entries(fields)) {
    const synonyms: readonly string[] = def.synonyms;
    const hit = headers.find((h) => synonyms.some((s) => norm(s) === norm(h)));
    mapping[key] = hit ?? null;
  }
  return mapping;
}

export function missingRequired(kind: ImportKind, mapping: ColumnMapping, headers: string[]): string[] {
  return Object.entries(fieldsFor(kind))
    .filter(([key, def]) => def.required && (!mapping[key] || !headers.includes(mapping[key]!)))
    .map(([, def]) => def.label);
}

/** Guess the import kind from headers. */
export function detectKind(headers: string[]): ImportKind | null {
  const h = headers.map(norm);
  if (h.includes(norm("COMBINED_NOTE_TEXT")) || h.includes("note id")) return "CLINICAL_NOTES";
  if (h.includes("complication")) return "HISTORICAL_COMPLICATIONS";
  return null;
}
