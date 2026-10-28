/**
 * PHI-safe structured logger. Only whitelisted metadata keys are emitted; free text
 * (note content, excerpts, identifiers) is never logged. Errors are reduced to
 * name + a scrubbed message.
 */
const SAFE_KEYS = new Set([
  "jobId",
  "jobType",
  "status",
  "count",
  "total",
  "processed",
  "failed",
  "durationMs",
  "model",
  "inputTokens",
  "outputTokens",
  "costUsd",
  "attempt",
  "queue",
  "manualVersion",
  "route",
  "method",
  "role",
  "code",
  "page",
  "rules",
]);

const DIGIT_RUN = /\d{5,}/g; // MRN/CSN/NOTE_ID-like runs
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;

export function scrub(text: string): string {
  return text.replace(EMAIL, "[email]").replace(DIGIT_RUN, "[id]").slice(0, 300);
}

function safeMeta(meta?: Record<string, unknown>) {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!SAFE_KEYS.has(k)) continue;
    out[k] = typeof v === "string" ? scrub(v) : v;
  }
  return out;
}

export function errorSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${scrub(err.message)}`;
  return scrub(String(err));
}

function emit(level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg: scrub(msg), ...safeMeta(meta) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, err?: unknown, meta?: Record<string, unknown>) => emit("error", err ? `${msg} — ${errorSummary(err)}` : msg, meta),
};
