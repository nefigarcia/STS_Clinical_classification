import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export const processingLimitsSchema = z.object({
  maxJobTokenBudget: z.number().int().positive(),
  maxEncounterCostUsd: z.number().positive(),
  maxEscalationRate: z.number().min(0).max(1),
  concurrency: z.number().int().min(1).max(16),
  retryLimit: z.number().int().min(0).max(10),
  dailyCostLimitUsd: z.number().positive(),
});

export const modelPriceSchema = z.object({
  inputPer1M: z.number().nonnegative(),
  cachedInputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
});

export const retrievalSchema = z.object({
  topRules: z.number().int().min(1).max(30),
  topExamples: z.number().int().min(0).max(10),
  maxPassages: z.number().int().min(5).max(120),
  passageChars: z.number().int().min(300).max(6000),
  passageOverlap: z.number().int().min(0).max(1000),
});

/** Staged pipeline: full-coverage screening → per-code checklist adjudication → consistency. */
export const PROFILES = {
  /** Every note screened; every flagged code adjudicated twice (disagreement → escalation model + human review). */
  audit: { screeningMode: "full", consistencyRuns: 2, screenChunkChars: 12000, maxPassagesPerCode: 12 },
  /** Keyword-selected passages only; single adjudication run (high-risk codes still get two). Lower recall. */
  economy: { screeningMode: "lexicon", consistencyRuns: 1, screenChunkChars: 12000, maxPassagesPerCode: 8 },
} as const;

export const pipelineSchema = z.object({
  /** Preset chosen in Settings; "custom" uses the advanced fields below as stored. */
  profile: z.enum(["audit", "economy", "custom"]).default("audit"),
  /** "full": screen every note in the STS window (audit-grade recall). "lexicon": screen keyword-selected passages only (cheaper). */
  screeningMode: z.enum(["full", "lexicon"]),
  /** Independent adjudication runs per flagged code; disagreement triggers the escalation model and human review. */
  consistencyRuns: z.number().int().min(1).max(3),
  /** STS field SeqNo(s) whose codes are the complications to detect (CHSD Postoperative Events = 4740). */
  eventFieldSeqNos: z.array(z.string()).min(1),
  screenChunkChars: z.number().int().min(2000).max(40000),
  maxPassagesPerCode: z.number().int().min(2).max(40),
});

export const settingsSchemas = {
  pipeline: pipelineSchema,
  processingLimits: processingLimitsSchema,
  /** Prices are entered by an administrator from the current OpenAI price sheet; never assumed. */
  modelPricing: z.record(z.string(), modelPriceSchema),
  retrieval: retrievalSchema,
  /** Historical/source label (lower-case) -> canonical complication name used for evaluation. */
  labelMap: z.record(z.string(), z.string()),
  /** Escalation triggers: predicted complication names containing any of these terms. */
  highRiskTerms: z.array(z.string()),
  /** Whether note passages may be embedded via the external embeddings API (still PHI-gated). */
  embedNotesAuthorized: z.boolean(),
  modelVerification: z.record(z.string(), z.object({ ok: z.boolean(), checkedAt: z.string(), error: z.string().nullable() })),
} as const;

export type SettingKey = keyof typeof settingsSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingsSchemas)[K]>;

export const settingDefaults: { [K in SettingKey]: SettingValue<K> } = {
  pipeline: { profile: "audit", screeningMode: "full", consistencyRuns: 2, eventFieldSeqNos: ["4740"], screenChunkChars: 12000, maxPassagesPerCode: 12 },
  processingLimits: {
    maxJobTokenBudget: 20_000_000,
    maxEncounterCostUsd: 10,
    maxEscalationRate: 0.25,
    concurrency: 8,
    retryLimit: 3,
    dailyCostLimitUsd: 50,
  },
  modelPricing: {},
  retrieval: { topRules: 8, topExamples: 3, maxPassages: 40, passageChars: 1500, passageOverlap: 200 },
  labelMap: {},
  highRiskTerms: ["cardiac arrest", "reoperation", "ecmo", "mechanical circulatory support", "death"],
  embedNotesAuthorized: false,
  modelVerification: {},
};

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  if (!row) return settingDefaults[key];
  const parsed = settingsSchemas[key].safeParse(row.value);
  return (parsed.success ? parsed.data : settingDefaults[key]) as SettingValue<K>;
}

export async function setSetting<K extends SettingKey>(key: K, value: unknown, userId?: string) {
  const parsed = settingsSchemas[key].parse(value) as Prisma.InputJsonValue;
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: parsed, updatedBy: userId },
    update: { value: parsed, updatedBy: userId },
  });
  return parsed;
}

export async function getAllSettings() {
  const entries = await Promise.all((Object.keys(settingsSchemas) as SettingKey[]).map(async (k) => [k, await getSetting(k)] as const));
  return Object.fromEntries(entries) as { [K in SettingKey]: SettingValue<K> };
}

/** Pipeline settings with the selected profile applied. */
export async function effectivePipeline() {
  const p = await getSetting("pipeline");
  return p.profile === "custom" ? p : { ...p, ...PROFILES[p.profile] };
}
