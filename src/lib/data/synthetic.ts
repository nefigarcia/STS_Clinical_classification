/**
 * Fully synthetic records shaped like the SampleNotes / Complications spreadsheets.
 * No real patient data. Identifiers deliberately include leading zeros to test preservation.
 */

export const SYN_NOTE_HEADERS = ["MRN", "PAT_ID", "CSN", "NOTE_ID", "COMBINED_NOTE_TEXT", "NOTE_TYPE", "DATE_OF_SERVICE", "LST_FILED_INST", "Flag Notes"];
export const SYN_COMP_HEADERS = ["MRN", "CSN", "Date of Service", "Complication", "Note Info", "Key Words", "Additional info"];

type NoteRow = Record<(typeof SYN_NOTE_HEADERS)[number], string>;

const filler =
  "Vital signs reviewed. Hemodynamics stable on current support. Nutrition advancing per protocol. Family updated at bedside. Continue current plan of care and monitor closely.";

export function syntheticNotes(): NoteRow[] {
  const rows: NoteRow[] = [];
  const add = (mrn: string, csn: string, noteId: string, type: string, dt: string, text: string) =>
    rows.push({
      MRN: mrn,
      PAT_ID: `Z${mrn.slice(-6)}`,
      CSN: csn,
      NOTE_ID: noteId,
      COMBINED_NOTE_TEXT: text,
      NOTE_TYPE: type,
      DATE_OF_SERVICE: dt,
      LST_FILED_INST: dt,
      "Flag Notes": "NULL",
    });

  // Patient A: multi-event postoperative course.
  add("0001001", "00500101", "000900001", "Op Note", "2026-01-05T08:00:00", `SYNTHETIC. Procedure: complete repair of congenital heart defect. ${filler}`);
  add(
    "0001001",
    "00500101",
    "000900002",
    "ICU Progress Note",
    "2026-01-06T07:30:00",
    `SYNTHETIC. POD1. Chest X-ray shows new right pneumothorax; chest tube placed at bedside with re-expansion. ${filler}`,
  );
  add(
    "0001001",
    "00500101",
    "000900003",
    "ICU Progress Note",
    "2026-01-07T07:30:00",
    `SYNTHETIC. POD2. Junctional ectopic tachycardia overnight treated with cooling and temporary pacing via atrial wires. No pneumothorax on today's film. ${filler}`,
  );
  add(
    "0001001",
    "00500101",
    "000900003",
    "ICU Progress Note",
    "2026-01-07T07:30:00",
    `SYNTHETIC. POD2. Junctional ectopic tachycardia overnight treated with cooling and temporary pacing via atrial wires. No pneumothorax on today's film. ${filler}`,
  ); // exact duplicate row
  add(
    "0001001",
    "00500101",
    "000900004",
    "Progress Notes",
    "2026-01-09T09:00:00",
    `SYNTHETIC. Milky chest tube output; pleural triglycerides elevated consistent with chylothorax. Started MCT formula and octreotide. ${filler}`,
  );
  add(
    "0001001",
    "00500101",
    "000900005",
    "Progress Notes",
    "2026-01-10T09:00:00",
    `SYNTHETIC. Chylothorax improving on MCT formula. Denies seizure activity. ${filler}`,
  );
  // Patient B: negated / historical mentions only + one real event.
  add(
    "0002002",
    "00600202",
    "000900101",
    "Brief Op Note",
    "2026-02-10T12:00:00",
    `SYNTHETIC. Brief op note: palliative shunt placement. History of seizures in infancy, none recent. ${filler}`,
  );
  add(
    "0002002",
    "00600202",
    "000900102",
    "ICU Progress Note",
    "2026-02-11T07:00:00",
    `SYNTHETIC. Extubated yesterday. Failed extubation this morning with increased work of breathing; reintubated at 06:10. ${filler}`,
  );
  add(
    "0002002",
    "00600202",
    "000900103",
    "ICU Progress Note",
    "2026-02-12T07:00:00",
    `SYNTHETIC. Plan for cardiac catheterization next week if gradient persists. No evidence of pleural effusion. ${filler}`,
  );
  // Invalid rows (kept and reported, never dropped silently)
  add("", "00600202", "000900104", "ICU Progress Note", "2026-02-13T07:00:00", `SYNTHETIC. Missing MRN row. ${filler}`);
  add("0002002", "00600202", "000900105", "ICU Progress Note", "NULL", "");
  return rows;
}

export function syntheticComplications(): Record<string, string>[] {
  return [
    {
      MRN: "0001001",
      CSN: "00500101",
      "Date of Service": "2026-01-06",
      Complication: "Pneumothorax",
      "Note Info": "ICU Progress Note",
      "Key Words": "pneumothorax, chest tube",
      "Additional info": "",
    },
    {
      MRN: "0001001",
      CSN: "00500101",
      "Date of Service": "2026-01-07",
      Complication: "Arrhythmia, temp pacer",
      "Note Info": "ICU Progress Note",
      "Key Words": "JET, temporary pacing",
      "Additional info": "",
    },
    {
      MRN: "0001001",
      CSN: "00500101",
      "Date of Service": "2026-01-09",
      Complication: "Chylothorax",
      "Note Info": "Progress Notes",
      "Key Words": "chylothorax, octreotide",
      "Additional info": "",
    },
    {
      MRN: "0002002",
      CSN: "00600202",
      "Date of Service": "2026-02-11",
      Complication: "Reintubation",
      "Note Info": "ICU Progress Note",
      "Key Words": "reintubated",
      "Additional info": "",
    },
    {
      MRN: "0002002",
      CSN: "00600202",
      "Date of Service": "2026-02-12",
      Complication: "Pleural effusion",
      "Note Info": "ICU Progress Note",
      "Key Words": "pleural effusion",
      "Additional info": "Synthetic label expected to be flagged: only a negated mention exists",
    },
  ];
}

export function toCsv(headers: string[], rows: Record<string, string>[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h] ?? "")).join(","))].join("\n");
}
