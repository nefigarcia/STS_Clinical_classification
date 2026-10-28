import { openai, modelConfig, withRetries, errorCode } from "./openai-client";
import { recordAiCall } from "./cost-tracker";

export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Embed texts in batches. Callers are responsible for the PHI gate: only send
 * text that may leave the environment (STS manual text, de-identified queries,
 * or authorized clinical text).
 */
export async function embedTexts(texts: string[], ctx: { purpose: string; jobId?: string | null; retryLimit?: number }): Promise<number[][]> {
  const model = modelConfig().embedding;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 96) {
    const batch = texts.slice(i, i + 96).map((t) => t.slice(0, 24_000));
    const started = Date.now();
    try {
      const { value, retries } = await withRetries(
        () => openai().embeddings.create({ model, input: batch, dimensions: EMBEDDING_DIMENSIONS }),
        ctx.retryLimit ?? 3,
      );
      await recordAiCall({
        jobId: ctx.jobId,
        purpose: ctx.purpose,
        model,
        usage: { inputTokens: value.usage?.prompt_tokens ?? 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        durationMs: Date.now() - started,
        retries,
        success: true,
      });
      for (const d of value.data.sort((a, b) => a.index - b.index)) out.push(d.embedding);
    } catch (err) {
      await recordAiCall({
        jobId: ctx.jobId,
        purpose: ctx.purpose,
        model,
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        durationMs: Date.now() - started,
        retries: (err as { retries?: number }).retries ?? 0,
        success: false,
        errorCode: errorCode(err),
      });
      throw err;
    }
  }
  return out;
}
