import { zodTextFormat } from "openai/helpers/zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { sha256 } from "@/lib/data/normalization";
import { getSetting } from "@/lib/settings";
import { classificationGate, encounterClassification } from "@/lib/security/gates";
import { allowedCodes } from "@/lib/sts/code-validator";
import { openai, modelConfig, withRetries, errorCode } from "./openai-client";
import { recordAiCall, spendToday, estimateTokens, computeCost } from "./cost-tracker";
import { embedTexts } from "./embeddings";
import { prepareEncounterPassages } from "./candidate-detection";
import { searchRules, selectManualVersion, type RetrievedRule } from "./sts-rules";
import { retrieveExamples } from "./evidence-retrieval";
import { activePrompt, buildUserPrompt } from "./prompts";
import { modelOutputSchema, type ModelOutput } from "./response-schema";
import { validateModelOutput, type ValidatedEvent, type ValidationSummary } from "./response-validator";
import { decideEscalation } from "./model-router";

export const OUTPUT_SCHEMA_VERSION = "1";

export class BudgetExceededError extends Error {}
export class GateClosedError extends Error {}

export type ClassifyOptions = {
  jobId?: string | null;
  forceEscalation?: boolean;
  /** Evaluation mode: use this model only, do not persist predictions, do not read cache. */
  evaluationModel?: string;
  escalationStats?: { escalated: number; processed: number };
};

export type ClassifyResult = {
  encounterId: string;
  events: ValidatedEvent[];
  persistedPredictionIds: string[];
  cacheHit: boolean;
  escalated: boolean;
  escalationReasons: string[];
  modelUsed: string;
  costUsd: number | null;
  passagesSent: number;
  manualVersion: string;
  manualSelection: string;
};

type CachedPayload = {
  events: SerializedEvent[];
  modelUsed: string;
  escalated: boolean;
  escalationReasons: string[];
  manualSelection: string;
  passagesSent: number;
};
type SerializedEvent = Omit<ValidatedEvent, "eventDate"> & { eventDate: string | null };

const serialize = (e: ValidatedEvent): SerializedEvent => ({ ...e, eventDate: e.eventDate ? e.eventDate.toISOString() : null });
const deserialize = (e: SerializedEvent): ValidatedEvent => ({ ...e, eventDate: e.eventDate ? new Date(e.eventDate) : null });

async function callModel(
  model: string,
  effort: string,
  system: string,
  user: string,
  ctx: { jobId?: string | null; encounterId: string; purpose: string; retryLimit: number },
) {
  const started = Date.now();
  try {
    const { value: res, retries } = await withRetries(
      () =>
        openai().responses.parse({
          model,
          reasoning: { effort: effort as "low" },
          store: false, // do not retain clinical content in the Responses store
          input: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          text: { format: zodTextFormat(modelOutputSchema, "clinical_classification") },
        }),
      ctx.retryLimit,
    );
    const usage = {
      inputTokens: res.usage?.input_tokens ?? 0,
      cachedInputTokens: res.usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      reasoningTokens: res.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    };
    const cost = await recordAiCall({
      jobId: ctx.jobId,
      encounterId: ctx.encounterId,
      purpose: ctx.purpose,
      model,
      reasoningEffort: effort,
      usage,
      durationMs: Date.now() - started,
      retries,
      success: true,
    });
    const parsed = res.output_parsed;
    if (!parsed) throw new Error("Model returned no parseable structured output");
    return { output: parsed as ModelOutput, cost, usage };
  } catch (err) {
    await recordAiCall({
      jobId: ctx.jobId,
      encounterId: ctx.encounterId,
      purpose: ctx.purpose,
      model,
      reasoningEffort: effort,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      durationMs: Date.now() - started,
      retries: (err as { retries?: number }).retries ?? 0,
      success: false,
      errorCode: errorCode(err),
    });
    throw err;
  }
}

/**
 * Classify one encounter: prepare notes -> candidate passages -> STS rule retrieval ->
 * verified example retrieval -> structured model call -> independent validation ->
 * optional escalation -> persistence (never auto-approved).
 */
export async function classifyEncounter(encounterId: string, opts: ClassifyOptions = {}): Promise<ClassifyResult> {
  const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId }, include: { patient: true, notes: true } });
  const dataClass = await encounterClassification(encounterId);
  const gate = await classificationGate(dataClass);
  if (!gate.allowed) throw new GateClosedError(gate.reasons.join(" "));

  const selection = await selectManualVersion(encounter.surgeryDate, encounter.surgeryDateSource);
  if (!selection) throw new GateClosedError("No approved STS manual");
  const manual = selection.manual;

  const [limits, retrieval, pricing, highRiskTerms, prompt] = await Promise.all([
    getSetting("processingLimits"),
    getSetting("retrieval"),
    getSetting("modelPricing"),
    getSetting("highRiskTerms"),
    activePrompt(),
  ]);
  const cfg = modelConfig();
  const primaryModel = opts.evaluationModel ?? cfg.primary;

  const prep = prepareEncounterPassages(encounter.notes, retrieval);
  const lib = await prisma.exampleLibraryVersion.findFirst({ where: { active: true }, select: { version: true } });
  const cacheKey = sha256(
    JSON.stringify({
      notes: prep.uniqueNotes.map((n) => n.contentHash).sort(),
      model: primaryModel,
      escalationModel: cfg.escalation,
      effort: [cfg.primaryEffort, cfg.escalationEffort],
      prompt: prompt.version,
      manual: manual.id,
      retrieval,
      library: lib?.version ?? null,
      schema: OUTPUT_SCHEMA_VERSION,
    }),
  );

  const base = { encounterId, manualVersion: manual.version, manualSelection: selection.selection };

  // Cache: identical inputs + configuration -> reuse the validated result.
  if (!opts.evaluationModel && !opts.forceEscalation) {
    const cached = await prisma.classificationCache.findUnique({ where: { cacheKey } });
    if (cached && !cached.invalidatedAt) {
      const payload = cached.result as unknown as CachedPayload;
      const events = payload.events.map(deserialize);
      const existing = await prisma.complicationPrediction.findMany({ where: { encounterId, cacheKey, supersededAt: null }, select: { id: true } });
      const ids = existing.length
        ? existing.map((p) => p.id)
        : await persist(encounterId, events, {
            ...ctxFor(payload.modelUsed, prompt.version, manual.id, manual.version, lib?.version ?? null, cacheKey, payload.escalated, opts.jobId),
          });
      return {
        ...base,
        events,
        persistedPredictionIds: ids,
        cacheHit: true,
        escalated: payload.escalated,
        escalationReasons: payload.escalationReasons,
        modelUsed: payload.modelUsed,
        costUsd: 0,
        passagesSent: payload.passagesSent,
      };
    }
  }

  if (prep.passages.length === 0) {
    // Nothing clinically relevant found by candidate discovery: record an empty result, no API call.
    const payload: CachedPayload = {
      events: [],
      modelUsed: "none (no candidate passages)",
      escalated: false,
      escalationReasons: [],
      manualSelection: selection.selection,
      passagesSent: 0,
    };
    if (!opts.evaluationModel) {
      await prisma.classificationCache.upsert({
        where: { cacheKey },
        create: {
          cacheKey,
          encounterId,
          model: payload.modelUsed,
          promptVersion: prompt.version,
          manualVersion: manual.version,
          result: payload as unknown as Prisma.InputJsonValue,
        },
        update: {},
      });
    }
    return {
      ...base,
      events: [],
      persistedPredictionIds: [],
      cacheHit: false,
      escalated: false,
      escalationReasons: [],
      modelUsed: payload.modelUsed,
      costUsd: 0,
      passagesSent: 0,
    };
  }

  // Budget checks before spending.
  const today = await spendToday();
  if (today >= limits.dailyCostLimitUsd) throw new BudgetExceededError(`Daily API cost limit $${limits.dailyCostLimitUsd} reached`);
  if (opts.jobId) {
    const job = await prisma.processingJob.findUnique({ where: { id: opts.jobId }, select: { tokenUsage: true } });
    if (job && job.tokenUsage >= limits.maxJobTokenBudget) throw new BudgetExceededError(`Job token budget ${limits.maxJobTokenBudget} reached`);
  }

  // Rule retrieval per candidate category (queries contain category names and matched terms only, never note text).
  const ruleQueries = prep.categories.map((c) => {
    const terms = [...new Set(prep.passages.flatMap((p) => p.hits.filter((h) => h.category === c).map((h) => h.term.toLowerCase())))].slice(0, 6);
    return `${c} ${terms.join(" ")}`;
  });
  let queryVectors: (number[] | null)[] = ruleQueries.map(() => null);
  if (manual.embeddingModel) {
    queryVectors = await embedTexts(ruleQueries, { purpose: "rule-query-embedding", jobId: opts.jobId, retryLimit: limits.retryLimit });
  }
  const perQuery = Math.max(2, Math.ceil(retrieval.topRules / Math.max(1, ruleQueries.length)));
  const ruleMap = new Map<string, RetrievedRule>();
  for (let i = 0; i < ruleQueries.length; i++) {
    for (const r of await searchRules(manual.id, ruleQueries[i], queryVectors[i], perQuery, { complicationOnly: true })) ruleMap.set(r.id, r);
    if (ruleMap.size < 2) for (const r of await searchRules(manual.id, ruleQueries[i], queryVectors[i], perQuery)) ruleMap.set(r.id, r);
  }
  const rules = [...ruleMap.values()].slice(0, retrieval.topRules + 4).map((r, i) => ({ ...r, label: `R${i + 1}` }));

  const { examples, libraryVersion } = await retrieveExamples({
    excludeMrn: encounter.patient.mrn,
    categories: prep.categories,
    queryEmbedding: null,
    k: retrieval.topExamples,
  });
  const labeledExamples = examples.map((e, i) => ({ ...e, label: `E${i + 1}` }));

  const userPrompt = buildUserPrompt({
    manualVersion: manual.version,
    surgeryDate: encounter.surgeryDate ? encounter.surgeryDate.toISOString().slice(0, 10) : null,
    passages: prep.passages,
    rules,
    examples: labeledExamples,
  });

  // Per-encounter cost guard (only enforceable when pricing is configured).
  const price = pricing[primaryModel];
  if (price) {
    const est =
      computeCost(
        primaryModel,
        { inputTokens: estimateTokens(prompt.systemPrompt + userPrompt), cachedInputTokens: 0, outputTokens: 2000, reasoningTokens: 0 },
        pricing,
      ) ?? 0;
    if (est > limits.maxEncounterCostUsd)
      throw new BudgetExceededError(`Estimated encounter cost $${est.toFixed(3)} exceeds limit $${limits.maxEncounterCostUsd}`);
  }

  const codes = await allowedCodes(manual.id);
  const vctx = { passages: prep.passages, rules, allowedCodes: codes };

  let modelUsed = primaryModel;
  let totalCost: number | null = 0;
  const addCost = (c: number | null) => (totalCost = c === null || totalCost === null ? null : totalCost + c);

  let output: ModelOutput;
  let validation: ValidationSummary;
  let escalated = false;
  let escalationReasons: string[] = [];

  if (opts.forceEscalation && !opts.evaluationModel) {
    modelUsed = cfg.escalation;
    const r = await callModel(cfg.escalation, cfg.escalationEffort, prompt.systemPrompt, userPrompt, {
      jobId: opts.jobId,
      encounterId,
      purpose: "classification-escalation",
      retryLimit: limits.retryLimit,
    });
    addCost(r.cost);
    output = r.output;
    validation = validateModelOutput(output, vctx);
    escalated = true;
    escalationReasons = ["reviewer requested second evaluation"];
  } else {
    const r = await callModel(primaryModel, cfg.primaryEffort, prompt.systemPrompt, userPrompt, {
      jobId: opts.jobId,
      encounterId,
      purpose: opts.evaluationModel ? "evaluation" : "classification",
      retryLimit: limits.retryLimit,
    });
    addCost(r.cost);
    output = r.output;
    validation = validateModelOutput(output, vctx);
    if (!opts.evaluationModel) {
      const decision = decideEscalation({
        output,
        validation,
        highRiskTerms,
        forced: false,
        escalationsSoFar: opts.escalationStats?.escalated ?? 0,
        processedSoFar: opts.escalationStats?.processed ?? 0,
        maxEscalationRate: limits.maxEscalationRate,
        primaryModel,
        escalationModel: cfg.escalation,
      });
      escalationReasons = decision.reasons;
      if (decision.escalate) {
        const r2 = await callModel(cfg.escalation, cfg.escalationEffort, prompt.systemPrompt, userPrompt, {
          jobId: opts.jobId,
          encounterId,
          purpose: "classification-escalation",
          retryLimit: limits.retryLimit,
        });
        addCost(r2.cost);
        const v2 = validateModelOutput(r2.output, vctx);
        escalated = true;
        // Keep the escalated result unless it is worse at validation.
        if (!v2.failed || validation.failed) {
          output = r2.output;
          validation = v2;
          modelUsed = cfg.escalation;
        }
      }
    }
  }

  const events = validation.events;
  let ids: string[] = [];
  if (!opts.evaluationModel) {
    ids = await persist(encounterId, events, ctxFor(modelUsed, prompt.version, manual.id, manual.version, libraryVersion, cacheKey, escalated, opts.jobId));
    const payload: CachedPayload = {
      events: events.map(serialize),
      modelUsed,
      escalated,
      escalationReasons,
      manualSelection: selection.selection,
      passagesSent: prep.passages.length,
    };
    await prisma.classificationCache.upsert({
      where: { cacheKey },
      create: {
        cacheKey,
        encounterId,
        model: modelUsed,
        promptVersion: prompt.version,
        manualVersion: manual.version,
        result: payload as unknown as Prisma.InputJsonValue,
      },
      update: { result: payload as unknown as Prisma.InputJsonValue, model: modelUsed, invalidatedAt: null },
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
    costUsd: totalCost,
    passagesSent: prep.passages.length,
  };
}

type PersistCtx = {
  modelVersion: string;
  promptVersion: string;
  manualVersionId: string;
  manualVersion: string;
  libraryVersion: number | null;
  cacheKey: string;
  escalated: boolean;
  jobId?: string | null;
};

function ctxFor(
  modelVersion: string,
  promptVersion: string,
  manualVersionId: string,
  manualVersion: string,
  libraryVersion: number | null,
  cacheKey: string,
  escalated: boolean,
  jobId?: string | null,
): PersistCtx {
  return { modelVersion, promptVersion, manualVersionId, manualVersion, libraryVersion, cacheKey, escalated, jobId };
}

/**
 * Persist validated events. Earlier AI predictions for the encounter that no reviewer has
 * touched are superseded (kept for audit); reviewed predictions are never modified.
 */
async function persist(encounterId: string, events: ValidatedEvent[], ctx: PersistCtx): Promise<string[]> {
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
          eventAssertion: e.assertion,
          evidenceStatus: e.evidenceStatus,
          reviewStatus: e.reviewStatus,
          confidenceScore: e.confidenceScore,
          uncertainty: e.uncertainty,
          clinicalEvidence: e.evidence
            .map((x) => x.excerpt)
            .join("\n---\n")
            .slice(0, 8000),
          aiExplanation: e.explanation,
          validationIssues: e.issues.length ? e.issues : undefined,
          manualReferenceId: e.rule?.id ?? null,
          manualVersionId: ctx.manualVersionId,
          manualPage: e.rule?.pageNumber ?? null,
          manualSection: e.rule?.sectionName ?? null,
          modelVersion: ctx.modelVersion,
          promptVersion: ctx.promptVersion,
          exampleLibraryVersion: ctx.libraryVersion,
          escalated: ctx.escalated,
          cacheKey: ctx.cacheKey,
          evidence: {
            create: e.evidence.map((x) => ({
              clinicalNoteId: x.clinicalNoteId,
              evidenceText: x.excerpt,
              evidenceStart: x.start,
              evidenceEnd: x.end,
              evidenceType: e.assertion,
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
