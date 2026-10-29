import { z } from "zod";
import { handle, currentUser, ApiError } from "@/lib/auth/guard";
import { parseJson } from "@/lib/api";
import { changeOwnPassword } from "@/lib/auth/password";

const schema = z.object({ current: z.string().min(1).max(1024), next: z.string().min(1).max(1024), confirm: z.string().max(1024) });

/** Change your own password. Allowed while a password change is required (unlike requireRole routes). */
export async function POST(req: Request) {
  return handle("POST /api/account/password", async () => {
    const user = await currentUser();
    if (!user) throw new ApiError(401, "Authentication required");
    if (!user.passwordHash) throw new ApiError(400, "This account signs in with Microsoft and has no app password");
    const body = await parseJson(req, schema);
    if (body.next !== body.confirm) throw new ApiError(400, "New passwords do not match");
    const problems = await changeOwnPassword(user.id, body.current, body.next);
    if (problems.length) throw new ApiError(400, problems.join(". "), { problems });
    return { ok: true };
  });
}
