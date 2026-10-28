import NextAuth, { type NextAuthConfig } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Credentials from "next-auth/providers/credentials";
import type { Role } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { env, entraConfigured, devLoginAllowed } from "@/lib/env";
import { mapEntraRoles } from "@/lib/auth/roles";
import { audit } from "@/lib/audit";
import { log } from "@/lib/security/logger";

/** Prisma error code (P1001 = DB unreachable, P2021 = table missing, …) when present. */
function prismaCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

declare module "next-auth" {
  interface Session {
    user: { id: string; email: string; name?: string | null; role: Role };
  }
}

const ROLES: Role[] = ["ADMIN", "REVIEWER", "READ_ONLY"];

function buildProviders(): NextAuthConfig["providers"] {
  const providers: NextAuthConfig["providers"] = [];
  if (entraConfigured()) {
    providers.push(
      MicrosoftEntraID({
        clientId: env().AUTH_MICROSOFT_ENTRA_ID_ID,
        clientSecret: env().AUTH_MICROSOFT_ENTRA_ID_SECRET,
        issuer: env().AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      }),
    );
  }
  if (devLoginAllowed()) {
    providers.push(
      Credentials({
        id: "dev-login",
        name: "Development login (synthetic data only)",
        credentials: { role: { label: "Role", type: "text" } },
        async authorize(creds) {
          const role = String(creds?.role ?? "") as Role;
          if (!ROLES.includes(role) || !devLoginAllowed()) return null;
          const email = `${role.toLowerCase().replace("_", "-")}@dev.local`;
          try {
            const user = await prisma.user.upsert({
              where: { email },
              create: { email, name: `Dev ${role}`, role },
              update: { role, lastLoginAt: new Date() },
            });
            return { id: user.id, email: user.email, name: user.name };
          } catch (err) {
            log.error("dev-login user upsert failed", err, { role, code: prismaCode(err) });
            throw err;
          }
        },
      }),
    );
  }
  return providers;
}

export const authConfig: NextAuthConfig = {
  providers: buildProviders(),
  session: { strategy: "jwt", maxAge: env().SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/sign-in" },
  trustHost: true,
  logger: {
    // Auth.js wraps the real failure (DB error, missing secret, …) in `cause.err`.
    error(error) {
      const cause = (error as { cause?: { err?: unknown } }).cause?.err;
      log.error(`auth ${error.name}`, cause ?? error, { code: prismaCode(cause) });
    },
  },
  callbacks: {
    async jwt({ token, account, profile, user }) {
      if (account?.provider === "microsoft-entra-id" && profile) {
        const email = String(profile.email ?? profile.preferred_username ?? token.email ?? "").toLowerCase();
        if (!email) throw new Error("Entra profile has no email");
        const oid = typeof profile.oid === "string" ? profile.oid : undefined;
        const claimRole = mapEntraRoles((profile as { roles?: unknown }).roles, env().ENTRA_ROLE_MAP);
        const bootstrapAdmins = (env().INITIAL_ADMIN_EMAILS ?? "")
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        const existing = await prisma.user.findUnique({ where: { email } });
        const role: Role = claimRole ?? existing?.role ?? (bootstrapAdmins.includes(email) ? "ADMIN" : "READ_ONLY");
        const dbUser = await prisma.user.upsert({
          where: { email },
          create: { email, name: profile.name ?? null, entraOid: oid, role, lastLoginAt: new Date() },
          update: { name: profile.name ?? undefined, entraOid: oid, role, lastLoginAt: new Date() },
        });
        token.uid = dbUser.id;
        await audit({ userId: dbUser.id, action: "auth.sign_in", entityType: "User", entityId: dbUser.id, metadata: { provider: "entra", role } });
      } else if (account?.provider === "dev-login" && user?.id) {
        token.uid = user.id;
        await audit({ userId: user.id, action: "auth.sign_in", entityType: "User", entityId: user.id, metadata: { provider: "dev-login" } });
      }
      return token;
    },
    async session({ session, token }) {
      const uid = typeof token.uid === "string" ? token.uid : null;
      const dbUser = uid ? await prisma.user.findUnique({ where: { id: uid } }) : null;
      if (dbUser && dbUser.active) {
        session.user = { id: dbUser.id, email: dbUser.email, name: dbUser.name, role: dbUser.role } as typeof session.user;
      } else {
        // Deactivated or unknown users get no identity.
        session.user = undefined as unknown as typeof session.user;
      }
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
