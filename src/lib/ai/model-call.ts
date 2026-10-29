import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { openai, withRetries, errorCode } from "./openai-client";
import { recordAiCall } from "./cost-tracker";

export type CallCtx = { jobId?: string | null; encounterId?: string | null; purpose: string; retryLimit: number };

/**
 * One metered Responses API call with Zod structured output. `store: false` keeps clinical text
 * out of the Responses store. Every attempt (success or failure) is recorded with tokens and cost.
 */
export async function callStructured<T extends z.ZodType>(
  model: string,
  effort: string,
  system: string,
  user: string,
  schema: T,
  schemaName: string,
  ctx: CallCtx,
): Promise<{ output: z.infer<T>; cost: number | null }> {
  const started = Date.now();
  try {
    const { value: res, retries } = await withRetries(
      () =>
        openai().responses.parse({
          model,
          reasoning: { effort: effort as "low" },
          store: false,
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
