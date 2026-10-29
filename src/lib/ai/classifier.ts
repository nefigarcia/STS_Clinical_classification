import type { ClassificationStatus, ClinicalNote, Prisma, ReviewStatus, STSManualRule } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { sha256, dateKey } from "@/lib/data/normalization";
import { getSetting } from "@/lib/settings";
import { classificationGate, encounterClassification } from "@/lib/security/gates";
import { buildChecklist, isScreenableCode, type CodeChecklist } from "@/lib/sts/criteria";
import { modelConfig } from "./openai-client";
import { spendToday } from "./cost-tracker";
import { prepareEncounterPassages } from "./candidate-detection";
import { selectManualVersion } from "./sts-rules";
import { retrieveExamples } from "./evidence-retrieval";
import { activePrompt } from "./prompts";
import { callStructured } from "./model-call";
import { noteSegments, screenSegment, type CatalogueEntry, type ScreenMention } from "./screening";
import {
  adjudicationSchema,
  buildAdjudicationPrompt,
  decide,
  describeWindow,
  validateAdjudication,
  type CodeDecision,
  type CriterionResult,
  type Outcome,
  type Passage,
} from "./adjudication";
import { checkEventDate, computeWindow, type EncounterDates, type TimeframeStatus } from "./timeframe";

/**
 * Audit-grade classification of one encounter:
 *  A. Screening   — every note in the STS window is screened against the full event catalogue (recall).
 *  B. Adjudication — each flagged code is judged criterion-by-criterion against its STS checklist,
 *                    `consistencyRuns` times; disagreement → escalation model tie-break + human review.
 *  C. Decision    — computed in code from verified answers + deterministic STS timeframe check.
 * Nothing is auto-approved.
 */

export const OUTPUT_SCHEMA_VERSION = "2";

export class BudgetExceededError extends Error {}
export class GateClosedError extends Error {}

export type ClassifyOptions = {
  jobId?: string | null;
  /** Reviewer-requested second evaluation: adjudicate with the escalation model. */
  forceEscalation?: boolean;
  /** Evaluation mode: this model for all stages; nothing persisted; screening cache still used. */
  evaluationModel?: string;
  escalationStats?: { escalated: number; processed: number };
};

export type EncounterEvent = {
  code: string;
  complication: string;
  stsCode: string;
  classificationStatus: ClassificationStatus;
  reviewStatus: ReviewStatus;
  outcome: Outcome;
  reasons: string[];
  criteria: CriterionResult[];
  evidence: { clinicalNoteId: string; noteId: string; excerpt: string; start: number; end: number; verified: boolean }[];
  eventDate: Date | null;
  eventDateSource: string;
  timeframe: { status: TimeframeStatus; window: string; classes: string | null };
  agreement: string;
  explanation: string;
  issues: string[];
  modelUsed: string;
  rule: Pick<STSManualRule, "id" | "pageNumber" | "sectionName">;
};

export type ClassifyResult = {
  encounterId: string;
  events: EncounterEvent[];
  persistedPredictionIds: string[];
  cacheHit: boolean;
  escalated: boolean;
  escalationReasons: string[];
  modelUsed: string;
  costUsd: number | null;
  passagesSent: number;
  notesScreened: number;
  manualVersion: string;
  manualSelection: string;
};

type Cost = { total: number | null };
const addCost = (c: Cost, v: number | null) => (c.total = c.total === null || v === null ? null : c.total + v);
const DAY = 86_400_000;

/** Encounter dates for the timeframe engine; hospital discharge falls back to the latest Discharge Summary note. */
export function encounterDates(
  enc: { surgeryDate: Date | null; orExitAt: Date | null; dischargeDate: Date | null; databaseDischargeDate: Date | null },
  notes: Pick<ClinicalNote, "noteType" | "dateOfService">[],
): { dates: EncounterDates; dischargeDerived: boolean } {
  let discharge = enc.dischargeDate;
  let derived = false;
  if (!discharge) {
    const ds = notes
      .filter((n) => /discharge summary/i.test(n.noteType ?? "") && n.dateOfService)
      .sort((a, b) => b.dateOfService!.getTime() - a.dateOfService!.getTime())[0];
    if (ds) {
      discharge = ds.dateOfService;
      derived = true;
    }
  }
  return {
    dates: { surgeryDate: enc.surgeryDate, orExitAt: enc.orExitAt, hospitalDischargeDate: discharge, databaseDischargeDate: enc.databaseDischargeDate },
    dischargeDerived: derived,
  };
}

function passageAround(note: ClinicalNote, start: number, end: number, radius = 900) {
  const t = note.combinedNoteText;
  let s = Math.max(0, start - radius);
  let e = Math.min(t.length, end + radius);
  const ws = t.lastIndexOf("\n", s + 200);
  if (ws > s - 200 && ws >= 0) s = ws + 1;
  const we = t.indexOf("\n", e - 200);
  if (we > 0 && we < e + 200) e = we;
  return { start: s, end: e };
}

/** Merge overlapping windows per note, order chronologically and cap the count (affirmed/possible first). */
function buildPassages(mentions: ScreenMention[], notes: Map<string, ClinicalNote>, max: number): Passage[] {
  const rank = (a: ScreenMention["assertion"]) => (a === "affirmed" ? 0 : a === "possible" ? 1 : 2);
  const sorted = [...mentions].sort((a, b) => rank(a.assertion) - rank(b.assertion));
  const windows = new Map<string, { start: number; end: number }[]>();
  let count = 0;
  for (const m of sorted) {
    const note = notes.get(m.clinicalNoteId);
    if (!note) continue;
    const w = passageAround(note, m.start, m.end);
    const list = windows.get(note.id) ?? [];
    const overlap = list.find((x) => w.start <= x.end && w.end >= x.start);
    if (overlap) {
      overlap.start = Math.min(overlap.start, w.start);
      overlap.end = Math.max(overlap.end, w.end);
    } else {
      if (count >= max) continue;
      list.push(w);
      count++;
    }
    windows.set(note.id, list);
  }
  const passages: Omit<Passage, "label">[] = [];
  for (const [noteId, list] of windows) {
    const n = notes.get(noteId)!;
    for (const w of list)
      passages.push({
        clinicalNoteId: n.id,
        noteId: n.noteId,
        noteType: n.noteType,
        date: n.dateOfService,
        start: w.start,
        end: w.end,
        text: n.combinedNoteText.slice(w.start, w.end),
      });
  }
  return passages
    .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0) || a.noteId.localeCompare(b.noteId) || a.start - b.start)
    .map((p, i) => ({ ...p, label: `P${i + 1}` }));
}

function timelineText(d: EncounterDates, dischargeDerived: boolean): string {
  const f = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : "unknown");
  return [
    `Index operation date: ${f(d.surgeryDate)}`,
    `OR exit: ${d.orExitAt ? d.orExitAt.toISOString().slice(0, 16).replace("T", " ") : "unknown"}`,
    `Hospital discharge: ${f(d.hospitalDischargeDate)}${dischargeDerived ? " (derived from discharge summary date)" : ""}`,
    `Database discharge / end of episode: ${f(d.databaseDischargeDate)}`,
  ].join("\n");
}

/** Event date: the model's date if consistent with the evidence, else the earliest verified evidence note date. */
function resolveEventDate(
  modelDate: string | null,
  evidence: { clinicalNoteId: string }[],
  notes: Map<string, ClinicalNote>,
): { date: Date | null; source: string } {
  const evDates = evidence.map((e) => notes.get(e.clinicalNoteId)?.dateOfService).filter((d): d is Date => Boolean(d));
  const latest = evDates.length ? Math.max(...evDates.map((d) => d.getTime())) : null;
  const m = modelDate?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    // A documented event cannot occur after the note that documents it (allow same day).
    if (!Number.isNaN(d.getTime()) && (latest === null || d.getTime() <= latest + DAY)) return { date: d, source: "documented in notes (model-extracted)" };
  }
  if (evDates.length) return { date: new Date(Math.min(...evDates.map((d) => d.getTime()))), source: "earliest evidence note date (approximate)" };
  return { date: null, source: "unknown" };
}

type RunResult = {
  decision: CodeDecision;
  results: CriterionResult[];
  issues: string[];
  eventDate: Date | null;
  eventDateSource: string;
  timeframe: TimeframeStatus;
  explanation: string;
  model: string;
};

export async function classifyEncounter(encounterId: string, opts: ClassifyOptions = {}): Promise<ClassifyResult> {
  const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, include: { patient: true, notes: true } });
  const gate = await classificationGate(await encounterClassification(encounterId));
  if (!gate.allowed) throw new GateClosedError(gate.reasons.join(" "));
  const selection = await selectManualVersion(encounter.surgeryDate, encounter.surgeryDateSource);
  if (!selection) throw new GateClosedError("No approved STS manual");
  const manual = selection.manual;

  const [limits, retrieval, pipeline, highRiskTerms, prompt] = await Promise.all([
    getSetting("processingLimits"),
    getSetting("retrieval"),
    getSetting("pipeline"),
    getSetting("highRiskTerms"),
    activePrompt(),
  ]);
  const cfg = modelConfig();
  const primary = opts.evaluationModel ?? cfg.primary;
  const adjudicator = opts.forceEscalation && !opts.evaluationModel ? cfg.escalation : primary;
  const adjEffort = opts.forceEscalation && !opts.evaluationModel ? cfg.escalationEffort : cfg.primaryEffort;

  // STS event catalogue (code-level rules of the configured event field(s)).
  const codeRules = await prisma.sTSManualRule.findMany({
    where: { manualVersionId: manual.id, seqNumber: { in: pipeline.eventFieldSeqNos }, stsCode: { not: null } },
    orderBy: { pageNumber: "asc" },
  });
  const checklists = new Map<string, { rule: STSManualRule; checklist: CodeChecklist }>();
  for (const r of codeRules) {
    if (!r.complicationName || !isScreenableCode(r.stsCode!, r.complicationName) || checklists.has(r.stsCode!)) continue;
    checklists.set(r.stsCode!, { rule: r, checklist: buildChecklist(r.stsCode!, r.complicationName, r.definition ?? "") });
  }
  if (checklists.size === 0) throw new GateClosedError(`The approved manual has no coded events for field(s) ${pipeline.eventFieldSeqNos.join(", ")}`);
  const catalogue: CatalogueEntry[] = [...checklists.values()].map(({ checklist }) => ({
    code: checklist.code,
    name: checklist.name,
    defined: (checklist.criteria.find((c) => c.kind === "defined")?.text ?? "").slice(0, 240),
  }));

  const { dates, dischargeDerived } = encounterDates(encounter, encounter.notes);
  const uniqueNotes = [...new Map(encounter.notes.map((n) => [n.contentHash, n])).values()];
  const noteById = new Map(encounter.notes.map((n) => [n.id, n]));

  // Notes in scope: from 2 days before the index operation (context for pre-existing conditions) onward.
  const scopeStart = dates.surgeryDate
    ? Date.UTC(dates.surgeryDate.getUTCFullYear(), dates.surgeryDate.getUTCMonth(), dates.surgeryDate.getUTCDate()) - 2 * DAY
    : null;
  const inScope = uniqueNotes.filter((n) => !n.dateOfService || scopeStart === null || n.dateOfService.getTime() >= scopeStart);

  const lib = await prisma.exampleLibraryVersion.findFirst({ where: { active: true }, select: { version: true } });
  const cacheKey = sha256(
    JSON.stringify({
      notes: inScope.map((n) => n.contentHash).sort(),
      models: [primary, adjudicator, cfg.escalation, cfg.primaryEffort, adjEffort, cfg.escalationEffort],
      prompt: prompt.version,
      manual: manual.id,
      pipeline,
      retrieval,
      dates: [dates.surgeryDate, dates.orExitAt, dates.hospitalDischargeDate, dates.databaseDischargeDate].map((d) => (d ? dateKey(d) : null)),
      library: lib?.version ?? null,
      schema: OUTPUT_SCHEMA_VERSION,
      force: Boolean(opts.forceEscalation),
    }),
  );
  const base = { encounterId, manualVersion: manual.version, manualSelection: selection.selection };

  if (!opts.evaluationModel) {
    const cached = await prisma.classificationCache.findUnique({ where: { cacheKey } });
    if (cached && !cached.invalidatedAt) {
      const ids = (await prisma.complicationPrediction.findMany({ where: { encounterId, cacheKey, supersededAt: null }, select: { id: true } })).map(
        (p) => p.id,
      );
      const payload = cached.result as unknown as { modelUsed: string; escalated: boolean; notesScreened: number; passagesSent: number };
      return {
        ...base,
        events: [],
        persistedPredictionIds: ids,
        cacheHit: true,
        escalated: payload.escalated,
        escalationReasons: [],
        modelUsed: payload.modelUsed,
        costUsd: 0,
        passagesSent: payload.passagesSent,
        notesScreened: payload.notesScreened,
      };
    }
  }

  const cost: Cost = { total: 0 };
  const guard = async () => {
    if ((await spendToday()) >= limits.dailyCostLimitUsd) throw new BudgetExceededError(`Daily API cost limit $${limits.dailyCostLimitUsd} reached`);
    if (opts.jobId) {
      const job = await prisma.processingJob.findUnique({ where: { id: opts.jobId }, select: { tokenUsage: true } });
      if (job && job.tokenUsage >= limits.maxJobTokenBudget) throw new BudgetExceededError(`Job token budget ${limits.maxJobTokenBudget} reached`);
    }
    if (cost.total !== null && cost.total > limits.maxEncounterCostUsd)
      throw new BudgetExceededError(`Per-encounter cost limit $${limits.maxEncounterCostUsd} exceeded`);
  };
  const ctx = { jobId: opts.jobId, encounterId, retryLimit: limits.retryLimit };

  // ---- Stage A: screening -------------------------------------------------------------
  const segments =
    pipeline.screeningMode === "full"
      ? inScope.flatMap((n) => noteSegments(n, pipeline.screenChunkChars))
      : prepareEncounterPassages(inScope, retrieval).passages.map((p) => ({
          clinicalNoteId: p.clinicalNoteId,
          text: p.text,
          offset: p.start,
          noteType: p.noteType,
          date: p.dateOfService,
        }));
  const mentions: ScreenMention[] = [];
  for (const seg of segments) {
    await guard();
    const r = await screenSegment(seg, catalogue, primary, cfg.primaryEffort, { ...ctx, purpose: "screening" });
    addCost(cost, r.cost);
    mentions.push(...r.mentions);
  }
  const flagged = [...new Set(mentions.filter((m) => m.assertion === "affirmed" || m.assertion === "possible").map((m) => m.code))];

  // ---- Stage B: per-code adjudication with consistency --------------------------------
  const events: EncounterEvent[] = [];
  let escalated = false;
  const escalationReasons: string[] = [];
  let passagesSent = 0;
  const timeline = timelineText(dates, dischargeDerived);

  for (const code of flagged) {
    const { rule, checklist } = checklists.get(code)!;
    const passages = buildPassages(
      mentions.filter((m) => m.code === code),
      noteById,
      pipeline.maxPassagesPerCode,
    );
    passagesSent += passages.length;
    const { examples } = await retrieveExamples({
      excludeMrn: encounter.patient.mrn,
      categories: [checklist.name],
      queryEmbedding: null,
      k: retrieval.topExamples,
    });
    const user = buildAdjudicationPrompt({
      checklist,
      manualVersion: manual.version,
      timeline,
      passages,
      examples: examples.map((e, i) => ({ label: `E${i + 1}`, complication: e.complication, evidence: e.clinicalEvidence })),
    });
    const window = computeWindow(checklist.timeframe, dates);

    const runOnce = async (model: string, effort: string, purpose: string): Promise<RunResult> => {
      await guard();
      const { output, cost: c } = await callStructured(model, effort, prompt.systemPrompt, user, adjudicationSchema, "code_adjudication", { ...ctx, purpose });
      addCost(cost, c);
      const { results, issues } = validateAdjudication(output, checklist, passages);
      const metEvidence = results.filter((r) => r.kind !== "exclusion" && r.effectiveStatus === "met").flatMap((r) => r.evidence);
      const ed = resolveEventDate(output.eventDate, metEvidence, noteById);
      const tf = checkEventDate(ed.date, window);
      return {
        decision: decide(results, tf),
        results,
        issues,
        eventDate: ed.date,
        eventDateSource: ed.source,
        timeframe: tf,
        explanation: output.explanation.slice(0, 2000),
        model,
      };
    };

    const runs: RunResult[] = [];
    // High-risk codes (arrest, reoperation, ECMO…) always get at least two independent runs.
    const highRisk = highRiskTerms.some((t) => checklist.name.toLowerCase().includes(t.toLowerCase()));
    const n = opts.forceEscalation && !opts.evaluationModel ? 1 : Math.max(pipeline.consistencyRuns, highRisk ? 2 : 1);
    for (let i = 0; i < n; i++)
      runs.push(await runOnce(adjudicator, adjEffort, opts.evaluationModel ? "evaluation" : i === 0 ? "adjudication" : "adjudication-consistency"));

    let final = runs[0];
    let agreement = n === 1 ? (opts.forceEscalation ? "single run (reviewer-requested escalation model)" : "single run") : `${n}/${n} runs agree`;
    const outcomes = new Set(runs.map((r) => r.decision.outcome));
    if (outcomes.size > 1) {
      const split = runs.map((r) => r.decision.outcome).join(" vs ");
      const stats = opts.escalationStats ?? { escalated: 0, processed: 0 };
      const rateOk = stats.processed === 0 || (stats.escalated + 1) / (stats.processed + 1) <= limits.maxEscalationRate;
      if (!opts.evaluationModel && cfg.escalation && cfg.escalation !== adjudicator && rateOk) {
        final = await runOnce(cfg.escalation, cfg.escalationEffort, "adjudication-tiebreak");
        escalated = true;
        escalationReasons.push(`code ${code}: runs disagreed (${split})`);
        agreement = `split (${split}); tie-break by ${cfg.escalation}: ${final.decision.outcome}`;
      } else {
        agreement = `split (${split}); no tie-break${rateOk ? "" : " (escalation-rate cap reached)"}`;
        final = {
          ...runs[0],
          decision: { outcome: "uncertain", classificationStatus: "SUSPECTED", reviewStatus: "NEEDS_REVIEW", reasons: ["Adjudication runs disagreed"] },
        };
      }
      // Any disagreement always goes to a human.
      final = {
        ...final,
        decision: {
          ...final.decision,
          reviewStatus: final.decision.classificationStatus === "EXCLUDED" ? "PENDING" : "NEEDS_REVIEW",
          reasons: [...final.decision.reasons, "Model runs disagreed — human review required"],
        },
      };
    }

    const evidence = final.results
      .filter((r) => (final.decision.outcome === "negative" ? true : r.kind !== "exclusion") && r.effectiveStatus === "met")
      .flatMap((r) => r.evidence);
    const dedup = [...new Map(evidence.map((e) => [`${e.clinicalNoteId}|${e.start}`, e])).values()];
    events.push({
      code,
      complication: checklist.name,
      stsCode: code,
      classificationStatus: final.decision.classificationStatus,
      reviewStatus: final.decision.reviewStatus,
      outcome: final.decision.outcome,
      reasons: final.decision.reasons,
      criteria: final.results,
      evidence: dedup,
      eventDate: final.eventDate,
      eventDateSource: final.eventDateSource,
      timeframe: { status: final.timeframe, window: describeWindow(window), classes: checklist.timeframe.raw },
      agreement,
      explanation: final.explanation,
      issues: final.issues,
      modelUsed: final.model,
      rule: { id: rule.id, pageNumber: rule.pageNumber, sectionName: rule.sectionName },
    });
  }

  const modelUsed = escalated ? `${adjudicator} + ${cfg.escalation} (tie-break)` : adjudicator;
  let ids: string[] = [];
  if (!opts.evaluationModel) {
    ids = await persist(encounterId, events, {
      promptVersion: prompt.version,
      manualVersionId: manual.id,
      libraryVersion: lib?.version ?? null,
      cacheKey,
      jobId: opts.jobId,
    });
    const payload = { modelUsed, escalated, notesScreened: inScope.length, passagesSent, codesFlagged: flagged.length, manualSelection: selection.selection };
    await prisma.classificationCache.upsert({
      where: { cacheKey },
      create: {
        cacheKey,
        encounterId,
        model: modelUsed,
        promptVersion: prompt.version,
        manualVersion: manual.version,
        result: payload as Prisma.InputJsonValue,
      },
      update: { result: payload as Prisma.InputJsonValue, model: modelUsed, invalidatedAt: null },
    });
  }
  return {
    ...base,
    events,
    persistedPredictionIds: ids,
    cacheHit: false,
    escalated,
    escalationReasons,
    modelUsed,
    costUsd: cost.total,
    passagesSent,
    notesScreened: inScope.length,
  };
}

/** Supersede untouched earlier AI predictions (kept for audit) and store the new per-code decisions. */
async function persist(
  encounterId: string,
  events: EncounterEvent[],
  ctx: { promptVersion: string; manualVersionId: string; libraryVersion: number | null; cacheKey: string; jobId?: string | null },
): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    await tx.complicationPrediction.updateMany({
      where: { encounterId, supersededAt: null, classificationStatus: { not: "REVIEWER_ADDED" }, reviews: { none: {} } },
      data: { supersededAt: new Date() },
    });
    const ids: string[] = [];
    for (const e of events) {
      const p = await tx.complicationPrediction.create({
        data: {
          encounterId,
          jobId: ctx.jobId ?? null,
          predictedComplication: e.complication,
          stsCode: e.stsCode,
          complicationEventDate: e.eventDate,
          classificationStatus: e.classificationStatus,
          eventAssertion: e.outcome,
          evidenceStatus: e.outcome === "positive" ? "supported" : e.outcome === "uncertain" ? "insufficient" : "not_met",
          reviewStatus: e.reviewStatus,
          confidenceScore: null, // no uncalibrated self-reported confidence; see agreement + criteria instead
          uncertainty: e.outcome === "uncertain" || e.agreement.startsWith("split") ? "high" : e.issues.length ? "medium" : "low",
          clinicalEvidence: e.evidence
            .map((x) => x.excerpt)
            .join("\n---\n")
            .slice(0, 8000),
          aiExplanation: e.explanation,
          validationIssues: [...e.reasons, ...e.issues].length ? [...e.reasons, ...e.issues] : undefined,
          criteriaResults: e.criteria as unknown as Prisma.InputJsonValue,
          timeframeCheck: {
            ...e.timeframe,
            eventDate: e.eventDate ? e.eventDate.toISOString().slice(0, 10) : null,
            eventDateSource: e.eventDateSource,
          } as Prisma.InputJsonValue,
          agreement: e.agreement,
          manualReferenceId: e.rule.id,
          manualVersionId: ctx.manualVersionId,
          manualPage: e.rule.pageNumber,
          manualSection: e.rule.sectionName,
          modelVersion: e.modelUsed,
          promptVersion: ctx.promptVersion,
          exampleLibraryVersion: ctx.libraryVersion,
          escalated: e.agreement.includes("tie-break by"),
          cacheKey: ctx.cacheKey,
          evidence: {
            create: e.evidence.map((x) => ({
              clinicalNoteId: x.clinicalNoteId,
              evidenceText: x.excerpt,
              evidenceStart: x.start,
              evidenceEnd: x.end,
              evidenceType: e.outcome,
              verified: x.verified,
            })),
          },
        },
      });
      ids.push(p.id);
    }
    return ids;
  });
}
