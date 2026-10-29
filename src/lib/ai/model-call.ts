import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { sha256 } from "@/lib/data/normalization";
import { openai, withRetries, errorCode } from "./openai-client";
import { recordAiCall } from "./cost-tracker";

export type CallCtx = { jobId?: string | null; encounterId?: string | null; purpose: string; retryLimit: number };

/**
 * One metered Responses API call with Zod structured output. `store: false` keeps clinical text
 * out of the Responses store. Static content belongs in `system` (and at the start of `user`) so
 * provider-side prompt caching applies; `promptCacheKey` groups calls that share that prefix.
 */
export async function callStructured<T extends z.ZodType>(
  model: string,
  effort: string,
  system: string,
  user: string,
  schema: T,
  schemaName: string,
  ctx: CallCtx,
  promptCacheKey?: string,
): Promise<{ output: z.infer<T>; cost: number | null }> {
  const started = Date.now();
  try {
    const { value: res, retries } = await withRetries(
      () =>
        openai().responses.parse({
          model,
          reasoning: { effort: effort as "low" },
          store: false,
          ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
          input: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          text: { format: zodTextFormat(schema, schemaName) },
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
    if (!res.output_parsed) throw new Error("Model returned no parseable structured output");
    return { output: res.output_parsed as z.infer<T>, cost };
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
 * callStructured with a persistent result cache (identical model + prompt → stored answer).
 * Lets interrupted work resume without paying again; `variant` distinguishes intentional repeats
 * (e.g. independent consistency runs of the same prompt).
 */
export async function cachedStructured<T extends z.ZodType>(
  namespace: string,
  model: string,
  effort: string,
  system: string,
  user: string,
  schema: T,
  schemaName: string,
  ctx: CallCtx,
  opts: { promptCacheKey?: string; variant?: string | number } = {},
): Promise<{ output: z.infer<T>; cost: number | null; cached: boolean }> {
  const key = `${namespace}:${sha256(JSON.stringify([model, effort, sha256(system), sha256(user), schemaName, opts.variant ?? 0]))}`;
  const hit = await prisma.noteScreenCache.findUnique({ where: { cacheKey: key } });
  if (hit) {
    const parsed = schema.safeParse(hit.result);
    if (parsed.success) return { output: parsed.data, cost: 0, cached: true };
  }
  const r = await callStructured(model, effort, system, user, schema, schemaName, ctx, opts.promptCacheKey);
  await prisma.noteScreenCache.upsert({
    where: { cacheKey: key },
    create: { cacheKey: key, result: r.output as unknown as Prisma.InputJsonValue },
    update: { result: r.output as unknown as Prisma.InputJsonValue },
  });
  return { ...r, cached: false };
}
