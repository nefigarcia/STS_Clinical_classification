import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/lib/auth/auth", () => ({ auth: authMock }));

const { prisma } = await import("@/lib/db/prisma");
const { requireRole, handle, ApiError } = await import("@/lib/auth/guard");
const { dbAvailable, resetDb, makeUser } = await import("./helpers");

const ready = await dbAvailable();

describe.skipIf(!ready)("server-side authorization", () => {
  beforeEach(async () => {
    await resetDb();
    authMock.mockReset();
  });

  it("returns 401 without a session and 403 for insufficient role", async () => {
    authMock.mockResolvedValue(null);
    const r1 = await handle("t", async () => requireRole("READ_ONLY"));
    expect(r1.status).toBe(401);
    const ro = await makeUser("READ_ONLY");
    authMock.mockResolvedValue({ user: { id: ro.id } });
    const r2 = await handle("t", async () => requireRole("REVIEWER"));
    expect(r2.status).toBe(403);
  });

  it("re-reads role from the database and denies deactivated users", async () => {
    const u = await makeUser("ADMIN");
    authMock.mockResolvedValue({ user: { id: u.id, role: "ADMIN" } });
    await expect(requireRole("ADMIN")).resolves.toMatchObject({ id: u.id });
    await prisma.user.update({ where: { id: u.id }, data: { role: "READ_ONLY" } });
    await expect(requireRole("ADMIN")).rejects.toBeInstanceOf(ApiError);
    await prisma.user.update({ where: { id: u.id }, data: { active: false } });
    await expect(requireRole("READ_ONLY")).rejects.toMatchObject({ status: 401 });
  });

  it("converts validation errors to 400 without leaking internals", async () => {
    const { z } = await import("zod");
    const r = await handle("t", async () => z.object({ a: z.string() }).parse({}));
    expect(r.status).toBe(400);
    const r500 = await handle("t", async () => {
      throw new Error("secret detail MRN 0001234");
    });
    expect(r500.status).toBe(500);
    expect(JSON.stringify(await r500.json())).not.toContain("0001234");
  });
});
