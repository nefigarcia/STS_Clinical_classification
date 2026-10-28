import type { Role, User } from "@prisma/client";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { hasRole } from "@/lib/auth/roles";
import { log } from "@/lib/security/logger";

import { ApiError } from "@/lib/errors";

export { ApiError };

/** Resolve the signed-in, active user from the session, re-reading role from the database. */
export async function currentUser(): Promise<User | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const user = await prisma.user.findUnique({ where: { id } });
  return user && user.active ? user : null;
}

/** Server-side authorization for every API route; UI visibility is never relied upon. */
export async function requireRole(required: Role): Promise<User> {
  const user = await currentUser();
  if (!user) throw new ApiError(401, "Authentication required");
  if (!hasRole(user.role, required)) throw new ApiError(403, `Requires ${required} role`);
  return user;
}

/** Page-level authorization: redirect instead of throwing. */
export async function requirePageRole(required: Role): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  if (!hasRole(user.role, required)) redirect("/dashboard?forbidden=1");
  return user;
}

/** Wrap a route handler body with uniform, PHI-safe error handling. */
export async function handle<T>(route: string, fn: () => Promise<T>): Promise<NextResponse> {
  try {
    const result = await fn();
    if (result instanceof Response) return result as unknown as NextResponse;
    return NextResponse.json(result ?? { ok: true });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message, details: err.details }, { status: err.status });
    }
    if (err instanceof ZodError) {
      return NextResponse.json({ error: "Invalid request", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, { status: 400 });
    }
    log.error(`Unhandled error in ${route}`, err, { route });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
