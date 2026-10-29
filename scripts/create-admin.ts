/**
 * Create (or reset) an administrator password account. Prints a one-time temporary password that
 * must be changed at first sign-in. Use once per environment to bootstrap the first admin; after
 * that, admins manage users in Settings → Users and roles.
 *
 *   npm run create-admin -- you@childrensnebraska.org ["Your Name"]
 *
 * For production, run with DATABASE_URL pointing at the production database (like migrations).
 */
import "dotenv/config";
import { prisma } from "../src/lib/db/prisma";
import { createPasswordUser } from "../src/lib/auth/password";

async function main() {
  const [email, ...nameParts] = process.argv.slice(2).filter((a) => a !== "--");
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Usage: npm run create-admin -- <email> ["Full Name"]');
  const { user, temporaryPassword } = await createPasswordUser({ email, name: nameParts.join(" ") || null, role: "ADMIN" }, null);
  console.log(`Administrator ready: ${user.email}`);
  console.log(`Temporary password (shown once): ${temporaryPassword}`);
  console.log("Sign in with it, then choose a new password when prompted.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
