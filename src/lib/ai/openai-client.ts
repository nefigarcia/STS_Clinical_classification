import OpenAI from "openai";
import { env } from "@/lib/env";

let client: OpenAI | null = null;

/** Server-only OpenAI client. Retries are handled by our own loop so every attempt is metered. */
export function openai(): OpenAI {
  const key = env().OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  if (!client) client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 120_000 });
  return client;
}

export function modelConfig() {
  const e = env();
  return {
    primary: e.OPENAI_PRIMARY_MODEL,
    escalation: e.OPENAI_ESCALATION_MODEL,
    embedding: e.OPENAI_EMBEDDING_MODEL,
    primaryEffort: e.OPENAI_REASONING_EFFORT,
    escalationEffort: e.OPENAI_ESCALATION_REASONING_EFFORT,
  };
}

/** Errors worth retrying: rate limits, timeouts, server errors. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) return err.status === 429 || (err.status ?? 0) >= 500;
  return err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.APIConnectionTimeoutError;
}

export function errorCode(err: unknown): string {
  if (err instanceof OpenAI.APIError) return `${err.status ?? "?"}:${err.code ?? err.type ?? "api_error"}`;
  if (err instanceof Error) return err.name;
  return "unknown";
}

export async function withRetries<T>(fn: () => Promise<T>, retryLimit: number): Promise<{ value: T; retries: number }> {
  let attempt = 0;
  for (;;) {
    try {
      return { value: await fn(), retries: attempt };
    } catch (err) {
      if (attempt >= retryLimit || !isRetryable(err)) {
        (err as { retries?: number }).retries = attempt;
        throw err;
      }
      attempt++;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500));
    }
  }
}
