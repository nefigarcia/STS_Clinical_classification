import { z } from "zod";
import { handle, requireRole } from "@/lib/auth/guard";
import { parseJson } from "@/lib/api";
import { getAllSettings, setSetting, settingsSchemas, type SettingKey } from "@/lib/settings";
import { systemStatus } from "@/lib/security/gates";
import { modelConfig } from "@/lib/ai/openai-client";
import { audit } from "@/lib/audit";

export async function GET() {
  return handle("GET /api/admin/settings", async () => {
    await requireRole("REVIEWER");
    return { settings: await getAllSettings(), status: await systemStatus(), models: modelConfig() };
  });
}

const EDITABLE = ["processingLimits", "modelPricing", "retrieval", "labelMap", "highRiskTerms", "embedNotesAuthorized"] as const;
const putSchema = z.object({ key: z.enum(EDITABLE), value: z.unknown() });

export async function PUT(req: Request) {
  return handle("PUT /api/admin/settings", async () => {
    const user = await requireRole("ADMIN");
    const { key, value } = await parseJson(req, putSchema);
    settingsSchemas[key as SettingKey].parse(value);
    const saved = await setSetting(key, value, user.id);
    await audit({ userId: user.id, action: "settings.update", entityType: "AppSetting", entityId: key });
    return { key, value: saved };
  });
}
