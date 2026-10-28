/**
 * Clinical vocabulary used ONLY to locate candidate passages (search guidance).
 * It is not an STS rule source: category names here are never emitted as STS
 * classifications, and a term hit is never treated as proof of an event.
 */
export const EVENT_LEXICON: Record<string, string[]> = {
  "cardiac arrest": ["cardiac arrest", "cpr", "chest compressions", "rosc", "code blue", "pulseless", "ecpr"],
  "unplanned reoperation": [
    "reoperation",
    "return to (the )?or",
    "returned to (the )?or",
    "re-?exploration",
    "take ?back",
    "washout",
    "mediastinal exploration",
    "unplanned (cardiac )?(re)?operation",
  ],
  "unplanned interventional catheterization": [
    "cath(eterization)?( lab)?",
    "interventional",
    "balloon (angioplasty|dilation)",
    "stent(ing|ed)?",
    "coil(ing|ed)?",
    "device closure",
  ],
  seizure: ["seizures?", "seizure activity", "status epilepticus", "anticonvulsant", "levetiracetam", "keppra", "phenobarbital", "fosphenytoin", "eeg"],
  pneumothorax: ["pneumothora(x|ces)", "ptx", "chest tube placed", "air leak"],
  reintubation: ["re-?intubat(ed|ion)", "failed extubation", "extubation failure", "emergent(ly)? intubat(ed|ion)"],
  arrhythmia: [
    "arrhythmias?",
    "junctional ectopic tachycardia",
    "\\bjet\\b",
    "svt",
    "supraventricular tachycardia",
    "ventricular tachycardia",
    "v-?tach",
    "heart block",
    "av block",
    "complete heart block",
    "temporary pac(ing|er)",
    "temp pacer",
    "atrial flutter",
    "atrial fibrillation",
    "pacing wires? (in use|used)",
  ],
  chylothorax: ["chylothorax", "chyle", "chylous", "octreotide", "mct formula", "monogen", "enfaport", "pleural triglycerides?"],
  "pleural effusion": ["pleural effusions?", "effusion requiring", "thoracentesis", "chest tube for effusion"],
  "pericardial effusion": ["pericardial effusion", "tamponade", "pericardiocentesis"],
  "mechanical circulatory support": ["ecmo", "extracorporeal", "vad", "ventricular assist"],
  "renal failure": ["dialysis", "crrt", "peritoneal dialysis", "acute kidney injury", "renal failure"],
  "neurologic deficit": ["stroke", "intracranial hemorrhage", "ich", "neurologic deficit", "hemiparesis"],
  "phrenic nerve / diaphragm": ["diaphragm(atic)? paralysis", "diaphragm plication", "phrenic nerve"],
  "vocal cord dysfunction": ["vocal cord paralysis", "vocal cord dysfunction", "vocal fold"],
  infection: ["sepsis", "mediastinitis", "wound infection", "clabsi", "endocarditis", "surgical site infection"],
  bleeding: ["postoperative bleeding", "bleeding requiring", "hemorrhage", "excessive chest tube output"],
  thrombosis: ["thrombus", "thrombosis", "dvt", "clot"],
};

const compiled = Object.entries(EVENT_LEXICON).map(([category, terms]) => ({
  category,
  re: new RegExp(`\\b(?:${terms.join("|")})`, "gi"),
}));

export type TermHit = { category: string; term: string; index: number };

export function findTermHits(text: string): TermHit[] {
  const hits: TermHit[] = [];
  for (const { category, re } of compiled) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) hits.push({ category, term: m[0], index: m.index! });
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** Build a case-insensitive matcher for free-text keyword lists (e.g. "Key Words" column). */
export function keywordRegex(keywords: string): RegExp | null {
  const parts = keywords
    .split(/[,;\n|]+/)
    .map((k) => k.trim())
    .filter((k) => k.length >= 3)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return parts.length ? new RegExp(`(?:${parts.join("|")})`, "gi") : null;
}
