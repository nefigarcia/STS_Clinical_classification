import type { ClassificationStatus, ReviewStatus } from "@prisma/client";
import type { CandidatePassage } from "./candidate-detection";
import type { RetrievedRule } from "./sts-rules";
import type { ModelEvent, ModelOutput } from "./response-schema";
import type { AllowedCode } from "@/lib/sts/code-validator";

export type ValidatedEvidence = {
  clinicalNoteId: string;
  noteId: string;
  excerpt: string;
  start: number | null;
  end: number | null;
  verified: boolean;
};

export type ValidatedEvent = {
  complication: string;
  stsCode: string | null;
  eventDate: Date | null;
  assertion: ModelEvent["assertion"];
  evidenceStatus: ModelEvent["evidenceStatus"];
  classificationStatus: ClassificationStatus;
  reviewStatus: ReviewStatus;
  rule: RetrievedRule | null;
  evidence: ValidatedEvidence[];
  explanation: string;
  confidenceScore: number | null;
  uncertainty: string;
  issues: string[];
};

export type ValidationSummary = { events: ValidatedEvent[]; failed: boolean; issues: string[] };

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Locate an excerpt inside the passage, tolerant only of whitespace/case differences. Returns note-level offsets. */
export function locateExcerpt(passage: CandidatePassage, excerpt: string): { start: number; end: number } | null {
  const target = squash(excerpt.replace(/^["'“”]+|["'“”]+$/g, ""));
  if (target.length < 4) return null;
  // Build a squashed copy of the passage with an index map back to original offsets.
  const map: number[] = [];
  let sq = "";
  let lastSpace = true;
  for (let i = 0; i < passage.text.length; i++) {
    const ch = passage.text[i];
    if (/\s/.test(ch)) {
      if (!lastSpace) {
        sq += " ";
        map.push(i);
      }
      lastSpace = true;
    } else {
      sq += ch.toLowerCase();
      map.push(i);
      lastSpace = false;
    }
  }
  const idx = sq.indexOf(target);
  if (idx < 0) return null;
  const startInPassage = map[idx];
  const endInPassage = map[idx + target.length - 1] + 1;
  return { start: passage.start + startInPassage, end: passage.start + endInPassage };
}

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Independently check the model's output against the retrieved sources:
 * - passage labels and excerpts must exist verbatim in the cited passage,
 * - rule labels must be among the retrieved rules,
 * - STS codes must exist in the indexed manual (and match the cited rule when it carries a code),
 * - unsupported "confirmed" events are downgraded and flagged for review,
 * - nothing is ever auto-approved.
 */
export function validateModelOutput(
  output: ModelOutput,
  ctx: { passages: CandidatePassage[]; rules: (RetrievedRule & { label: string })[]; allowedCodes: Map<string, AllowedCode> },
): ValidationSummary {
  const passageByLabel = new Map(ctx.passages.map((p) => [p.label.toUpperCase(), p]));
  const ruleByLabel = new Map(ctx.rules.map((r) => [r.label.toUpperCase(), r]));
  const globalIssues: string[] = [];
  let failed = false;

  const events: ValidatedEvent[] = output.events.map((e) => {
    const issues: string[] = [];
    const evidence: ValidatedEvidence[] = [];
    for (const ev of e.evidence) {
      const p = passageByLabel.get(ev.passageRef.trim().toUpperCase());
      if (!p) {
        issues.push(`Evidence cites unknown passage "${ev.passageRef}"`);
        continue;
      }
      const loc = locateExcerpt(p, ev.excerpt);
      if (!loc) issues.push(`Excerpt not found verbatim in ${p.label} (NOTE_ID ${p.noteId})`);
      evidence.push({
        clinicalNoteId: p.clinicalNoteId,
        noteId: p.noteId,
        excerpt: ev.excerpt.slice(0, 1000),
        start: loc?.start ?? null,
        end: loc?.end ?? null,
        verified: Boolean(loc),
      });
    }

    let rule: RetrievedRule | null = null;
    if (e.ruleRef) {
      rule = ruleByLabel.get(e.ruleRef.trim().toUpperCase()) ?? null;
      if (!rule) issues.push(`Cites rule "${e.ruleRef}" that was not provided`);
    } else if (e.assertion === "confirmed" || e.assertion === "suspected") {
      issues.push("No STS rule cited for this event");
    }

    let stsCode = e.stsCode?.trim() || null;
    if (stsCode) {
      if (!ctx.allowedCodes.has(stsCode)) {
        issues.push(`STS code "${stsCode}" does not exist in the indexed manual; removed`);
        // Fall back only to a code carried by the cited source rule itself.
        stsCode = rule?.stsCode ?? null;
      } else if (rule?.stsCode && rule.stsCode !== stsCode) {
        issues.push(`STS code "${stsCode}" does not match cited rule code "${rule.stsCode}"; using rule code`);
        stsCode = rule.stsCode;
      } else if (rule && !rule.stsCode && !rule.chunkText.includes(stsCode)) {
        issues.push(`STS code "${stsCode}" does not appear in the cited rule text; removed`);
        stsCode = null;
      }
    } else if (rule?.stsCode) {
      stsCode = rule.stsCode;
    }

    const complication = (rule?.complicationName && stsCode === rule.stsCode ? rule.complicationName : e.complication).slice(0, 300);
    const verifiedEvidence = evidence.filter((x) => x.verified);
    let evidenceStatus = e.evidenceStatus;
    let classificationStatus: ClassificationStatus;
    let reviewStatus: ReviewStatus = "PENDING";

    switch (e.assertion) {
      case "negated":
      case "historical":
      case "planned":
      case "outside_window":
        classificationStatus = "EXCLUDED";
        break;
      case "insufficient":
        classificationStatus = "INSUFFICIENT_EVIDENCE";
        reviewStatus = "NEEDS_REVIEW";
        break;
      case "suspected":
        classificationStatus = "SUSPECTED";
        reviewStatus = "NEEDS_REVIEW";
        break;
      default:
        classificationStatus = "SUGGESTED";
    }
    if (e.evidenceStatus === "conflicting" && classificationStatus !== "EXCLUDED") {
      classificationStatus = "CONFLICTING_EVIDENCE";
      reviewStatus = "NEEDS_REVIEW";
    }
    if ((classificationStatus === "SUGGESTED" || classificationStatus === "SUSPECTED") && verifiedEvidence.length === 0) {
      issues.push("No verifiable source evidence; downgraded to insufficient evidence");
      classificationStatus = "INSUFFICIENT_EVIDENCE";
      evidenceStatus = "insufficient";
      reviewStatus = "NEEDS_REVIEW";
    }
    if (classificationStatus === "SUGGESTED" && issues.length > 0) reviewStatus = "NEEDS_REVIEW";
    if (classificationStatus !== "EXCLUDED" && issues.length > 0) failed = true;

    const conf = e.confidenceScore;
    return {
      complication,
      stsCode,
      eventDate: parseDate(e.eventDate),
      assertion: e.assertion,
      evidenceStatus,
      classificationStatus,
      reviewStatus,
      rule,
      evidence,
      explanation: e.explanation.slice(0, 2000),
      confidenceScore: conf === null || Number.isNaN(conf) ? null : Math.min(1, Math.max(0, conf)),
      uncertainty: e.uncertainty,
      issues,
    };
  });

  return { events: mergeDuplicateEvents(events), failed, issues: globalIssues };
}

/** Several notes documenting one event must yield one prediction with combined evidence. */
export function mergeDuplicateEvents(events: ValidatedEvent[]): ValidatedEvent[] {
  const out = new Map<string, ValidatedEvent>();
  for (const e of events) {
    const key = `${e.complication.toLowerCase().replace(/\W+/g, " ").trim()}|${e.stsCode ?? ""}|${e.eventDate?.toISOString().slice(0, 10) ?? ""}|${e.classificationStatus === "EXCLUDED"}`;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, e);
      continue;
    }
    const seen = new Set(prev.evidence.map((x) => `${x.clinicalNoteId}|${x.start}`));
    for (const ev of e.evidence) if (!seen.has(`${ev.clinicalNoteId}|${ev.start}`)) prev.evidence.push(ev);
    prev.issues.push(...e.issues);
    if (e.evidenceStatus === "conflicting") prev.evidenceStatus = "conflicting";
  }
  return [...out.values()];
}
