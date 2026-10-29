import { z } from "zod";
import type { ClassificationStatus, ReviewStatus } from "@prisma/client";
import type { CodeChecklist, Criterion } from "@/lib/sts/criteria";
import type { TimeframeStatus, TimeWindow } from "./timeframe";
import { locateExcerpt } from "./excerpt";

/**
 * Stage B — per-code checklist adjudication. The model answers each STS criterion for one code
 * (Defined / Code this Event / each exclusion) with verbatim evidence. The final decision is then
 * computed deterministically from verified answers plus the code-computed timeframe check.
 */

export const adjudicationSchema = z.object({
  criteria: z.array(
    z.object({
      id: z.string().describe("Criterion id from the checklist, e.g. D1, C1, E2"),
      status: z.enum(["met", "not_met", "unclear"]).describe("For exclusions (E*): met = the exclusion APPLIES"),
      evidence: z.array(z.object({ passageRef: z.string(), excerpt: z.string() })),
      rationale: z.string().describe("One or two sentences"),
    }),
  ),
  eventDate: z.string().nullable().describe("YYYY-MM-DD the event occurred, if documented; else null"),
  explanation: z.string().describe("2-4 sentences summarizing how the documentation meets or fails the STS definition"),
});
export type AdjudicationOutput = z.infer<typeof adjudicationSchema>;

export type Passage = {
  label: string;
  clinicalNoteId: string;
  noteId: string;
  noteType: string | null;
  date: Date | null;
  start: number;
  end: number;
  text: string;
};

export type VerifiedEvidence = { clinicalNoteId: string; noteId: string; excerpt: string; start: number; end: number; verified: true };

export type CriterionResult = {
  id: string;
  kind: Criterion["kind"];
  text: string;
  status: "met" | "not_met" | "unclear";
  /** Status after evidence checks: a "met" without verifiable evidence is downgraded to "unclear". */
  effectiveStatus: "met" | "not_met" | "unclear";
  evidence: VerifiedEvidence[];
  rejectedEvidence: number;
  rationale: string;
};

export type Outcome = "positive" | "negative" | "uncertain";

export type CodeDecision = {
  outcome: Outcome;
  classificationStatus: ClassificationStatus;
  reviewStatus: ReviewStatus;
  reasons: string[];
};

export function buildAdjudicationPrompt(input: {
  checklist: CodeChecklist;
  manualVersion: string;
  timeline: string;
  passages: Passage[];
  examples: { label: string; complication: string; evidence: string }[];
}): string {
  const c = input.checklist;
  const crit = c.criteria.map((k) => `<criterion id="${k.id}" kind="${k.kind}">\n${k.text}\n</criterion>`).join("\n");
  const passages = input.passages
    .map(
      (p) =>
        `<passage label="${p.label}" note_type="${(p.noteType ?? "").replace(/[<>"]/g, " ")}" date="${p.date ? p.date.toISOString().slice(0, 10) : "unknown"}">\n${p.text}\n</passage>`,
    )
    .join("\n");
  const examples = input.examples.length
    ? input.examples.map((e) => `<example label="${e.label}" verified_label="${e.complication.replace(/[<>"]/g, " ")}">\n${e.evidence}\n</example>`).join("\n")
    : "(none)";
  return `STS CHSD Training Manual version ${input.manualVersion}
Event under review: code ${c.code} — ${c.name}

<sts_definition>
${c.fullDefinition}
</sts_definition>

<checklist>
${crit}
</checklist>

<encounter_timeline>
${input.timeline}
</encounter_timeline>

<verified_examples>
${examples}
</verified_examples>

<clinical_passages>
${passages}
</clinical_passages>

Answer EVERY checklist criterion (D*, C*, E*). For exclusions, "met" means the exclusion applies to this patient. Cite exact quotes from the passages as evidence for every "met" answer. Use "unclear" when documentation is insufficient. Report the date the event occurred if documented. Timing against the STS window is checked separately by the system.`;
}

/** Map model answers to verified criterion results. Unknown ids are ignored; unanswered criteria become "unclear". */
export function validateAdjudication(out: AdjudicationOutput, checklist: CodeChecklist, passages: Passage[]): { results: CriterionResult[]; issues: string[] } {
  const byLabel = new Map(passages.map((p) => [p.label.toUpperCase(), p]));
  const answers = new Map(out.criteria.map((a) => [a.id.trim().toUpperCase(), a]));
  const issues: string[] = [];
  for (const id of answers.keys()) if (!checklist.criteria.some((c) => c.id === id)) issues.push(`Answer for unknown criterion "${id}" ignored`);
  const results = checklist.criteria.map((c): CriterionResult => {
    const a = answers.get(c.id);
    if (!a) {
      issues.push(`Criterion ${c.id} not answered; treated as unclear`);
      return { id: c.id, kind: c.kind, text: c.text, status: "unclear", effectiveStatus: "unclear", evidence: [], rejectedEvidence: 0, rationale: "" };
    }
    const evidence: VerifiedEvidence[] = [];
    let rejected = 0;
    for (const e of a.evidence) {
      const p = byLabel.get(e.passageRef.trim().toUpperCase());
      const loc = p ? locateExcerpt(p.text, e.excerpt, p.start) : null;
      if (!p || !loc) {
        rejected++;
        continue;
      }
      evidence.push({ clinicalNoteId: p.clinicalNoteId, noteId: p.noteId, excerpt: e.excerpt.slice(0, 1000), start: loc.start, end: loc.end, verified: true });
    }
    if (rejected) issues.push(`${c.id}: ${rejected} cited quote(s) not found verbatim in the passages`);
    const effective = a.status === "met" && evidence.length === 0 ? "unclear" : a.status;
    if (a.status === "met" && evidence.length === 0) issues.push(`${c.id} answered "met" without verifiable evidence; downgraded to unclear`);
    return {
      id: c.id,
      kind: c.kind,
      text: c.text,
      status: a.status,
      effectiveStatus: effective,
      evidence,
      rejectedEvidence: rejected,
      rationale: a.rationale.slice(0, 1000),
    };
  });
  return { results, issues };
}

/**
 * Deterministic decision. Positive only when every required criterion (Defined, Code this Event)
 * is met with verified evidence, no exclusion applies, and the event date is inside the STS window.
 * Nothing is ever auto-approved: positives are PENDING human review.
 */
export function decide(results: CriterionResult[], timeframe: TimeframeStatus): CodeDecision {
  const required = results.filter((r) => r.kind !== "exclusion");
  const exclusions = results.filter((r) => r.kind === "exclusion");
  const applied = exclusions.filter((r) => r.effectiveStatus === "met");
  if (applied.length) {
    return {
      outcome: "negative",
      classificationStatus: "EXCLUDED",
      reviewStatus: "PENDING",
      reasons: applied.map((r) => `STS exclusion ${r.id} applies: ${r.text.slice(0, 160)}`),
    };
  }
  const notMet = required.filter((r) => r.effectiveStatus === "not_met");
  if (notMet.length) {
    return { outcome: "negative", classificationStatus: "EXCLUDED", reviewStatus: "PENDING", reasons: notMet.map((r) => `Criterion ${r.id} not met`) };
  }
  const unclear = required.filter((r) => r.effectiveStatus === "unclear");
  if (unclear.length || required.length === 0) {
    return {
      outcome: "uncertain",
      classificationStatus: "SUSPECTED",
      reviewStatus: "NEEDS_REVIEW",
      reasons: unclear.map((r) => `Criterion ${r.id} unclear from documentation`),
    };
  }
  // All required criteria met with verified evidence.
  if (timeframe === "before_window") {
    return {
      outcome: "negative",
      classificationStatus: "EXCLUDED",
      reviewStatus: "PENDING",
      reasons: ["Event precedes the index operation / OR exit (not a postoperative event)"],
    };
  }
  if (timeframe === "after_window") {
    return {
      outcome: "negative",
      classificationStatus: "EXCLUDED",
      reviewStatus: "PENDING",
      reasons: ["Event occurred after the STS timeframe for this code"],
    };
  }
  const reasons: string[] = [];
  let reviewStatus: ReviewStatus = "PENDING";
  if (timeframe === "unverifiable") {
    reviewStatus = "NEEDS_REVIEW";
    reasons.push("STS timeframe could not be verified (event date or encounter dates missing)");
  }
  const unclearExcl = exclusions.filter((r) => r.effectiveStatus === "unclear");
  if (unclearExcl.length) {
    reviewStatus = "NEEDS_REVIEW";
    reasons.push(`Exclusion(s) ${unclearExcl.map((r) => r.id).join(", ")} could not be ruled out`);
  }
  return { outcome: "positive", classificationStatus: "SUGGESTED", reviewStatus, reasons };
}

export function describeWindow(w: TimeWindow): string {
  if (!w.start || !w.end) return w.basis;
  return `${w.start.toISOString().slice(0, 10)} → ${w.end.toISOString().slice(0, 10)}${w.endProvisional ? " (provisional end)" : ""} — ${w.basis}`;
}
