/**
 * Multi-label evaluation at the encounter level. Labels are compared after mapping
 * through the administrator-maintained label map (historical label -> canonical name).
 * Results are development diagnostics, not validated clinical performance.
 */

export type EncounterLabels = {
  encounterId: string;
  mrn: string;
  csn: string;
  date: string | null;
  expected: string[];
  predicted: { label: string; uncertain: boolean; evidenceVerified: boolean | null; evidenceNoteIds: string[] }[];
  expectedSupportingNoteIds: string[];
  processed: boolean;
};

export type RowResult = "correct" | "false_positive" | "false_negative" | "incorrect_classification" | "unreviewed" | "uncertain";

export type ComparisonRow = {
  encounterId: string;
  mrn: string;
  csn: string;
  date: string | null;
  expected: string | null;
  predicted: string | null;
  result: RowResult;
};

export type Metrics = {
  encounters: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  exactMatchAccuracy: number | null;
  evidenceCitationAccuracy: number | null;
  perLabel: { label: string; tp: number; fp: number; fn: number; sensitivity: number | null }[];
};

export function normalizeLabel(label: string, labelMap: Record<string, string>): string {
  const key = label.trim().toLowerCase();
  const mapped = labelMap[key] ?? label;
  return mapped.trim().toLowerCase().replace(/\s+/g, " ");
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

export function computeMetrics(data: EncounterLabels[], labelMap: Record<string, string>): { metrics: Metrics; rows: ComparisonRow[] } {
  const rows: ComparisonRow[] = [];
  const processed = data.filter((d) => d.processed);
  const vocab = new Set<string>();
  for (const d of processed) {
    d.expected.forEach((l) => vocab.add(normalizeLabel(l, labelMap)));
    d.predicted.forEach((p) => vocab.add(normalizeLabel(p.label, labelMap)));
  }
  const per = new Map<string, { tp: number; fp: number; fn: number }>();
  const bump = (l: string, k: "tp" | "fp" | "fn") => {
    const e = per.get(l) ?? { tp: 0, fp: 0, fn: 0 };
    e[k]++;
    per.set(l, e);
  };
  let tp = 0,
    fp = 0,
    fn = 0,
    exact = 0,
    citeOk = 0,
    citeTotal = 0;

  for (const d of data) {
    const base = { encounterId: d.encounterId, mrn: d.mrn, csn: d.csn, date: d.date };
    if (!d.processed) {
      for (const e of d.expected) rows.push({ ...base, expected: e, predicted: null, result: "unreviewed" });
      continue;
    }
    const exp = new Map(d.expected.map((l) => [normalizeLabel(l, labelMap), l]));
    const pred = new Map(d.predicted.map((p) => [normalizeLabel(p.label, labelMap), p]));
    const unmatchedExp: string[] = [];
    const unmatchedPred: string[] = [];
    for (const [k, original] of exp) {
      const p = pred.get(k);
      if (p) {
        tp++;
        bump(k, "tp");
        rows.push({ ...base, expected: original, predicted: p.label, result: p.uncertain ? "uncertain" : "correct" });
        if (p.evidenceVerified !== null) {
          citeTotal++;
          const overlap = d.expectedSupportingNoteIds.length === 0 || p.evidenceNoteIds.some((n) => d.expectedSupportingNoteIds.includes(n));
          if (p.evidenceVerified && overlap) citeOk++;
        }
      } else unmatchedExp.push(k);
    }
    for (const [k] of pred) if (!exp.has(k)) unmatchedPred.push(k);
    if (unmatchedExp.length === 0 && unmatchedPred.length === 0) exact++;
    // Pair leftover expected/predicted on the same encounter as "incorrect classification".
    const pairs = Math.min(unmatchedExp.length, unmatchedPred.length);
    for (let i = 0; i < unmatchedExp.length; i++) {
      fn++;
      bump(unmatchedExp[i], "fn");
      const predLabel = i < pairs ? pred.get(unmatchedPred[i])!.label : null;
      rows.push({ ...base, expected: exp.get(unmatchedExp[i])!, predicted: predLabel, result: i < pairs ? "incorrect_classification" : "false_negative" });
    }
    for (let i = 0; i < unmatchedPred.length; i++) {
      fp++;
      bump(unmatchedPred[i], "fp");
      const p = pred.get(unmatchedPred[i])!;
      if (i >= pairs) rows.push({ ...base, expected: null, predicted: p.label, result: p.uncertain ? "uncertain" : "false_positive" });
    }
  }
  // TN over (encounter x label vocabulary) for processed encounters.
  const tn = Math.max(0, processed.length * vocab.size - tp - fp - fn);
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return {
    metrics: {
      encounters: processed.length,
      tp,
      fp,
      fn,
      tn,
      precision,
      recall,
      f1,
      falsePositiveRate: ratio(fp, fp + tn),
      falseNegativeRate: ratio(fn, fn + tp),
      exactMatchAccuracy: ratio(exact, processed.length),
      evidenceCitationAccuracy: ratio(citeOk, citeTotal),
      perLabel: [...per.entries()].map(([label, v]) => ({ label, ...v, sensitivity: ratio(v.tp, v.tp + v.fn) })).sort((a, b) => a.label.localeCompare(b.label)),
    },
    rows,
  };
}
