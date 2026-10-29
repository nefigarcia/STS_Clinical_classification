import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { handle, requireRole, ApiError } from "@/lib/auth/guard";
import { parseJson } from "@/lib/api";
import { audit } from "@/lib/audit";
import { createPasswordUser, resetPassword, unlockUser } from "@/lib/auth/password";

const ROLE = z.enum(["ADMIN", "REVIEWER", "READ_ONLY"]);

export async function GET() {
  return handle("GET /api/admin/users", async () => {
    await requireRole("ADMIN");
    const users = await prisma.user.findMany({
      orderBy: { email: "asc" },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        lastLoginAt: true,
        createdAt: true,
        entraOid: true,
        passwordHash: true,
        mustChangePassword: true,
        lockedUntil: true,
      },
    });
    // Never send hashes to the browser; expose only whether a password exists.
    return {
      users: users.map(({ passwordHash, entraOid, lockedUntil, ...u }) => ({
        ...u,
        hasPassword: Boolean(passwordHash),
        sso: Boolean(entraOid),
        locked: Boolean(lockedUntil && lockedUntil > new Date()),
      })),
    };
  });
}

const createSchema = z.object({ email: z.string().trim().toLowerCase().email().max(320), name: z.string().trim().max(200).optional().nullable(), role: ROLE });

/** Create a password account. The temporary password is returned ONCE and never stored in plain text. */
export async function POST(req: Request) {
  return handle("POST /api/admin/users", async () => {
    const admin = await requireRole("ADMIN");
    const body = await parseJson(req, createSchema);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing?.passwordHash) throw new ApiError(409, "A user with this email already has a password; use Reset password instead");
    const { user, temporaryPassword } = await createPasswordUser(body, admin.id);
    return { id: user.id, email: user.email, temporaryPassword };
  });
}

const patchSchema = z.object({
  id: z.string(),
  role: ROLE.optional(),
  active: z.boolean().optional(),
  action: z.enum(["reset_password", "unlock"]).optional(),
});

export async function PATCH(req: Request) {
  return handle("PATCH /api/admin/users", async () => {
    const admin = await requireRole("ADMIN");
    const body = await parseJson(req, patchSchema);
    if (body.id === admin.id && ((body.role !== undefined && body.role !== "ADMIN") || body.active === false)) {
      throw new ApiError(400, "Administrators cannot demote or deactivate themselves");
    }
    if (body.action === "reset_password") {
      if (body.id === admin.id) throw new ApiError(400, "Use Change password for your own account");
      return { temporaryPassword: await resetPassword(body.id, admin.id) };
    }
    if (body.action === "unlock") {
      await unlockUser(body.id, admin.id);
      return { ok: true };
    }
    const user = await prisma.user.update({ where: { id: body.id }, data: { role: body.role, active: body.active } });
    await audit({
      userId: admin.id,
      action: "user.update",
      entityType: "User",
      entityId: user.id,
      metadata: { role: body.role ?? null, active: body.active ?? null },
    });
    return { ok: true };
  });
}
