import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole } from "@/lib/auth/guard";
import { parseJson } from "@/lib/api";
import { activateLibraryVersion, activatePromptVersion, createPromptVersion, snapshotLibrary } from "@/lib/review/example-library";
import { DEFAULT_PROMPT_VERSION, DEFAULT_SYSTEM_PROMPT } from "@/lib/ai/prompts";

/** Prompt versions and example-library versions (for audit and rollback). */
export async function GET() {
  return handle("GET /api/admin/versions", async () => {
    await requireRole("REVIEWER");
    const [prompts, libraries] = await Promise.all([
      prisma.promptVersion.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.exampleLibraryVersion.findMany({ orderBy: { version: "desc" }, take: 50 }),
    ]);
    return {
      prompts,
      libraries: libraries.map((l) => ({ ...l, count: l.exampleIds.length, exampleIds: undefined })),
      defaultPrompt: { version: DEFAULT_PROMPT_VERSION, systemPrompt: DEFAULT_SYSTEM_PROMPT },
    };
  });
}

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_prompt"),
    version: z.string().regex(/^[\w.-]{1,40}$/),
    systemPrompt: z.string().min(50).max(20000),
    notes: z.string().max(2000).nullable().optional(),
    activate: z.boolean().default(false),
  }),
  z.object({ action: z.literal("activate_prompt"), version: z.string() }),
  z.object({ action: z.literal("snapshot_library"), notes: z.string().max(500).default("Manual snapshot") }),
  z.object({ action: z.literal("activate_library"), version: z.number().int() }),
]);

export async function POST(req: Request) {
  return handle("POST /api/admin/versions", async () => {
    const user = await requireRole("ADMIN");
    const body = await parseJson(req, postSchema);
    switch (body.action) {
      case "create_prompt":
        await createPromptVersion(user, body);
        break;
      case "activate_prompt":
        await activatePromptVersion(body.version, user);
        break;
      case "snapshot_library":
        return { version: await snapshotLibrary(user, body.notes) };
      case "activate_library":
        await activateLibraryVersion(body.version, user);
        break;
    }
    return { ok: true };
  });
}
