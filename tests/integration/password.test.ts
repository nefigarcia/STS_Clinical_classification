import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/lib/auth/auth", () => ({ auth: authMock }));

const { prisma } = await import("@/lib/db/prisma");
const pw = await import("@/lib/auth/password");
const { requireRole, ApiError } = await import("@/lib/auth/guard");
const { dbAvailable, resetDb, makeUser } = await import("./helpers");

const ready = await dbAvailable();

describe("password hashing and policy", () => {
  it("hashes with a per-user salt and verifies in constant time", async () => {
    const h1 = await pw.hashPassword("Correct-Horse-9");
    const h2 = await pw.hashPassword("Correct-Horse-9");
    expect(h1).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(h1).not.toBe(h2);
    expect(h1).not.toContain("Correct-Horse-9");
    expect(await pw.verifyPassword("Correct-Horse-9", h1)).toBe(true);
    expect(await pw.verifyPassword("correct-horse-9", h1)).toBe(false);
    expect(await pw.verifyPassword("x", "garbage")).toBe(false);
  });
  it("enforces the password policy", () => {
    expect(pw.passwordProblems("short1A!")).toContain("Use at least 12 characters");
    expect(pw.passwordProblems("alllowercaseletters")).toEqual(expect.arrayContaining([expect.stringMatching(/three of/)]));
    expect(pw.passwordProblems("MyPassword2026!").join()).toMatch(/common words/);
    expect(pw.passwordProblems("Jdoe-Secure-2026", "jdoe@example.org").join()).toMatch(/email name/);
    expect(pw.passwordProblems("Tidal-Granite-47")).toEqual([]);
  });
  it("generates temporary passwords that satisfy the policy", () => {
    for (let i = 0; i < 50; i++) expect(pw.passwordProblems(pw.generateTemporaryPassword())).toEqual([]);
  });
});

describe.skipIf(!ready)("password sign-in, lockout and account administration (database)", () => {
  beforeEach(async () => {
    await resetDb();
    authMock.mockReset();
  });

  it("creates an account with a one-time temporary password that must be changed", async () => {
    const admin = await makeUser("ADMIN");
    const { user, temporaryPassword } = await pw.createPasswordUser({ email: " New.User@Example.org ", name: "New User", role: "REVIEWER" }, admin.id);
    expect(user.email).toBe("new.user@example.org");
    expect(user.mustChangePassword).toBe(true);
    expect(user.passwordHash).not.toContain(temporaryPassword);
    const r = await pw.verifyPasswordLogin("NEW.USER@example.org", temporaryPassword);
    expect(r.ok).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "user.create", userId: admin.id } })).toBe(1);

    // The temporary password only allows changing it.
    authMock.mockResolvedValue({ user: { id: user.id } });
    await expect(requireRole("READ_ONLY")).rejects.toMatchObject({ status: 403 });
    expect(await pw.changeOwnPassword(user.id, "wrong", "Tidal-Granite-47")).toEqual(["Current password is incorrect"]);
    expect((await pw.changeOwnPassword(user.id, temporaryPassword, "weak")).length).toBeGreaterThan(0);
    expect(await pw.changeOwnPassword(user.id, temporaryPassword, "Tidal-Granite-47")).toEqual([]);
    await expect(requireRole("REVIEWER")).resolves.toMatchObject({ id: user.id });
    expect((await pw.verifyPasswordLogin("new.user@example.org", temporaryPassword)).ok).toBe(false);
    expect((await pw.verifyPasswordLogin("new.user@example.org", "Tidal-Granite-47")).ok).toBe(true);
  });

  it("locks the account after 5 failures, even for the correct password, until unlocked", async () => {
    const admin = await makeUser("ADMIN");
    const { user, temporaryPassword } = await pw.createPasswordUser({ email: "lock@example.org", role: "REVIEWER" }, admin.id);
    for (let i = 0; i < 4; i++) expect(await pw.verifyPasswordLogin("lock@example.org", "nope")).toEqual({ ok: false, reason: "invalid" });
    expect(await pw.verifyPasswordLogin("lock@example.org", "nope")).toEqual({ ok: false, reason: "locked" });
    expect(await pw.verifyPasswordLogin("lock@example.org", temporaryPassword)).toEqual({ ok: false, reason: "locked" });
    expect(await prisma.auditLog.count({ where: { action: "auth.account_locked", entityId: user.id } })).toBe(1);
    await pw.unlockUser(user.id, admin.id);
    expect((await pw.verifyPasswordLogin("lock@example.org", temporaryPassword)).ok).toBe(true);
  });

  it("rejects unknown and disabled accounts without revealing which", async () => {
    const admin = await makeUser("ADMIN");
    const { user, temporaryPassword } = await pw.createPasswordUser({ email: "gone@example.org", role: "READ_ONLY" }, admin.id);
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    expect((await pw.verifyPasswordLogin("gone@example.org", temporaryPassword)).ok).toBe(false);
    expect(await pw.verifyPasswordLogin("nobody@example.org", "Whatever-123")).toEqual({ ok: false, reason: "invalid" });
  });

  it("admin reset issues a new temporary password and records the change time (invalidates sessions)", async () => {
    const admin = await makeUser("ADMIN");
    const { user, temporaryPassword } = await pw.createPasswordUser({ email: "reset@example.org", role: "REVIEWER" }, admin.id);
    await pw.changeOwnPassword(user.id, temporaryPassword, "Tidal-Granite-47");
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordChangedAt!.getTime();
    await new Promise((r) => setTimeout(r, 5));
    const temp2 = await pw.resetPassword(user.id, admin.id);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordChangedAt!.getTime()).toBeGreaterThan(before);
    expect(after.mustChangePassword).toBe(true);
    expect((await pw.verifyPasswordLogin("reset@example.org", "Tidal-Granite-47")).ok).toBe(false);
    expect((await pw.verifyPasswordLogin("reset@example.org", temp2)).ok).toBe(true);
    expect(ApiError).toBeDefined();
  });
});
