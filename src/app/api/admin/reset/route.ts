import { z } from "zod";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { parseJson, searchParams } from "@/lib/api";
import { previewReset, resetAllowed, resetClassifications } from "@/lib/admin/reset";

/** Preview what a classification reset would delete. */
export async function GET(req: Request) {
  return handle("GET /api/admin/reset", async () => {
    await requireRole("ADMIN");
    return { allowed: resetAllowed(), counts: await previewReset(searchParams(req).get("screening") === "1") };
  });
}

const schema = z.object({ confirm: z.literal("RESET"), includeScreeningCache: z.boolean().default(false) });

/** Delete AI classification results (testing only). Requires typing RESET; refused in production. */
export async function POST(req: Request) {
  return handle("POST /api/admin/reset", async () => {
    const user = await requireRole("ADMIN");
    const body = await parseJson(req, schema);
    if (!resetAllowed()) throw new ApiError(403, "Resetting classification data is disabled in production");
    try {
      return { counts: await resetClassifications({ includeScreeningCache: body.includeScreeningCache, userId: user.id, via: "ui" }) };
    } catch (e) {
      throw new ApiError(409, (e as Error).message);
    }
  });
}
