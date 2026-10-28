import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { testDatabaseUrl } from "./test-db-url";

/**
 * Create and migrate an isolated test database (never the development database).
 * If Postgres is unreachable, integration tests skip themselves.
 */
export default async function setup() {
  const url = testDatabaseUrl();
  if (!url) return;
  const admin = new URL(url);
  const dbName = admin.pathname.slice(1).split("?")[0];
  admin.pathname = "/postgres";
  const client = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
  try {
    const exists = await client.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_database WHERE datname = $1`, dbName);
    if (exists.length === 0) await client.$executeRawUnsafe(`CREATE DATABASE "${dbName.replace(/"/g, "")}"`);
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });
    process.env.INTEGRATION_DB_READY = "1";
  } catch (e) {
    console.warn(`[tests] Integration database unavailable (${(e as Error).message.split("\n")[0]}); integration tests will be skipped.`);
  } finally {
    await client.$disconnect();
  }
}
