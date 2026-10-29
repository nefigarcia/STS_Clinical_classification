import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => (v ?? "").trim().toLowerCase() === "true");

const schema = z.object({
  APP_ENV: z.enum(["local", "test", "staging", "production"]).default("local"),
  DATABASE_URL: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  REFERENCE_DATA_DIR: z.string().default("./reference-data"),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(100),
  AUTH_DEV_LOGIN_ENABLED: bool,
  /** Explicit opt-in to the password-less role picker in production / with PHI (pilot use only). */
  AUTH_DEV_LOGIN_UNSAFE_OVERRIDE: bool,
  /** Email + password accounts managed by administrators (default on; set "false" to allow SSO only). */
  AUTH_PASSWORD_LOGIN_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").trim().toLowerCase() !== "false"),
  AUTH_MICROSOFT_ENTRA_ID_ID: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().optional(),
  AUTH_MICROSOFT_ENTRA_ID_ISSUER: z.string().optional(),
  ENTRA_ROLE_MAP: z.string().optional(),
  INITIAL_ADMIN_EMAILS: z.string().optional(),
  SESSION_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 60 * 60),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_PRIMARY_MODEL: z.string().default("gpt-6-luna"),
  OPENAI_ESCALATION_MODEL: z.string().default("gpt-6.1-sol"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_REASONING_EFFORT: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).default("low"),
  OPENAI_ESCALATION_REASONING_EFFORT: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).default("medium"),
  PHI_EXTERNAL_AI_APPROVED: bool,
});

export type AppEnv = z.infer<typeof schema>;

let cached: AppEnv | null = null;

/** Parsed server configuration. Never import from client components. */
export function env(): AppEnv {
  if (!cached || process.env.NODE_ENV === "test") {
    const blankToUndefined = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, v === "" ? undefined : v]));
    const parsed = schema.safeParse(blankToUndefined);
    if (!parsed.success) {
      // Name the offending variables (never their values) so the deploy logs say what to fix.
      const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      console.error(`Invalid environment configuration — ${detail}`);
      throw new Error(`Invalid environment configuration — ${detail}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function entraConfigured(): boolean {
  const e = env();
  return Boolean(e.AUTH_MICROSOFT_ENTRA_ID_ID && e.AUTH_MICROSOFT_ENTRA_ID_SECRET && e.AUTH_MICROSOFT_ENTRA_ID_ISSUER);
}

/** Dev login is refused in production and whenever PHI processing has been approved. */
export function devLoginAllowed(): boolean {
  const e = env();
  if (!e.AUTH_DEV_LOGIN_ENABLED) return false;
  return e.AUTH_DEV_LOGIN_UNSAFE_OVERRIDE || (e.APP_ENV !== "production" && !e.PHI_EXTERNAL_AI_APPROVED);
}

export function passwordLoginEnabled(): boolean {
  return env().AUTH_PASSWORD_LOGIN_ENABLED;
}
