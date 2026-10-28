import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { openai, modelConfig, errorCode } from "@/lib/ai/openai-client";
import { getSetting, setSetting } from "@/lib/settings";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";

/**
 * Check the configured model IDs against the OpenAI account (models.retrieve).
 * No clinical data is sent. Models that fail are reported, never silently substituted.
 */
export async function POST() {
  return handle("POST /api/admin/verify-models", async () => {
    const user = await requireRole("ADMIN");
    if (!env().OPENAI_API_KEY) throw new ApiError(409, "OPENAI_API_KEY is not configured");
    const cfg = modelConfig();
    const result = { ...(await getSetting("modelVerification")) };
    for (const id of [...new Set([cfg.primary, cfg.escalation, cfg.embedding])]) {
      try {
        await openai().models.retrieve(id);
        result[id] = { ok: true, checkedAt: new Date().toISOString(), error: null };
      } catch (err) {
        result[id] = { ok: false, checkedAt: new Date().toISOString(), error: errorCode(err) };
      }
    }
    await setSetting("modelVerification", result, user.id);
    await audit({
      userId: user.id,
      action: "models.verify",
      entityType: "AppSetting",
      entityId: "modelVerification",
      metadata: Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v.ok])),
    });
    return { verification: result };
  });
}
