import { randomBytes, scrypt as scryptCb, timingSafeEqual, randomInt } from "node:crypto";
import { promisify } from "node:util";
import type { Role, User } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { audit } from "@/lib/audit";

/**
 * Local password accounts (used when Microsoft Entra ID is not configured, or alongside it).
 * - scrypt (memory-hard) with a per-user random salt; only the hash is stored.
 * - Accounts are created by an administrator with a one-time temporary password and must change it at first sign-in.
 * - 5 consecutive failures lock the account for 15 minutes.
 * - Changing/resetting a password invalidates existing sessions (see auth.ts).
 */

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60_000;
export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const COMMON = ["password", "123456", "qwerty", "letmein", "welcome", "children", "nebraska", "admin", "changeme"];

/** Returns a list of problems; empty means the password is acceptable. */
export function passwordProblems(password: string, email?: string): string[] {
  const problems: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) problems.push("Use at least three of: lowercase, uppercase, digits, symbols");
  const lower = password.toLowerCase();
  if (COMMON.some((w) => lower.includes(w))) problems.push("Avoid common words such as 'password' or the organization name");
  const local = email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 3 && lower.includes(local)) problems.push("Do not include your email name");
  return problems;
}

/** Readable one-time password (no ambiguous characters); satisfies the policy. */
export function generateTemporaryPassword(): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%*?"];
  const all = sets.join("");
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < 16) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export type LoginResult = { ok: true; user: User } | { ok: false; reason: "invalid" | "locked" | "disabled" };

/**
 * Verify an email/password sign-in. Failures are counted and audited; the same generic message is
 * shown to the user for unknown email, wrong password and disabled accounts.
 */
export async function verifyPasswordLogin(emailRaw: string, password: string): Promise<LoginResult> {
  const email = emailRaw.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    // Spend comparable time so response timing does not reveal which emails exist.
    await verifyPassword(password, "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64"));
    await audit({ action: "auth.password_failed", entityType: "User", metadata: { reason: "unknown_account" } });
    return { ok: false, reason: "invalid" };
  }
  if (!user.active) {
    await audit({ userId: user.id, action: "auth.password_failed", entityType: "User", entityId: user.id, metadata: { reason: "disabled" } });
    return { ok: false, reason: "disabled" };
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({ userId: user.id, action: "auth.password_failed", entityType: "User", entityId: user.id, metadata: { reason: "locked" } });
    return { ok: false, reason: "locked" };
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED_ATTEMPTS;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MS) : user.lockedUntil },
    });
    await audit({
      userId: user.id,
      action: lock ? "auth.account_locked" : "auth.password_failed",
      entityType: "User",
      entityId: user.id,
      metadata: { failed },
    });
    return { ok: false, reason: lock ? "locked" : "invalid" };
  }
  const updated = await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
  await audit({ userId: user.id, action: "auth.sign_in", entityType: "User", entityId: user.id, metadata: { provider: "password" } });
  return { ok: true, user: updated };
}

/** User changes their own password (requires the current one). */
export async function changeOwnPassword(userId: string, current: string, next: string): Promise<string[]> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.passwordHash || !(await verifyPassword(current, user.passwordHash))) return ["Current password is incorrect"];
  const problems = passwordProblems(next, user.email);
  if (await verifyPassword(next, user.passwordHash)) problems.push("Choose a password different from the current one");
  if (problems.length) return problems;
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(next), mustChangePassword: false, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  });
  await audit({ userId, action: "auth.password_changed", entityType: "User", entityId: userId });
  return [];
}

/** Admin: create a password account (or add a password to an existing user). Returns the one-time temporary password. */
export async function createPasswordUser(input: { email: string; name?: string | null; role: Role }, actorId: string | null) {
  const email = input.email.trim().toLowerCase();
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const existing = await prisma.user.findUnique({ where: { email } });
  const user = existing
    ? await prisma.user.update({
        where: { email },
        data: {
          role: input.role,
          name: input.name ?? existing.name,
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: new Date(),
          active: true,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      })
    : await prisma.user.create({
        data: { email, name: input.name ?? null, role: input.role, passwordHash, mustChangePassword: true, passwordChangedAt: new Date() },
      });
  await audit({
    userId: actorId,
    action: existing ? "user.password_set" : "user.create",
    entityType: "User",
    entityId: user.id,
    metadata: { role: input.role },
  });
  return { user, temporaryPassword };
}

/** Admin: reset a password to a new one-time temporary password (also unlocks, and signs the user out everywhere). */
export async function resetPassword(userId: string, actorId: string) {
  const temporaryPassword = generateTemporaryPassword();
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  await audit({ userId: actorId, action: "user.password_reset", entityType: "User", entityId: userId });
  return temporaryPassword;
}

export async function unlockUser(userId: string, actorId: string) {
  await prisma.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null } });
  await audit({ userId: actorId, action: "user.unlock", entityType: "User", entityId: userId });
}
