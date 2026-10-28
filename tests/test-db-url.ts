import fs from "node:fs";
import dotenv from "dotenv";

/** Derive a dedicated test database URL (…/<db>_test) from .env, or use TEST_DATABASE_URL. */
export function testDatabaseUrl(): string | null {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const env = fs.existsSync(".env") ? dotenv.parse(fs.readFileSync(".env")) : {};
  const base = process.env.DATABASE_URL ?? env.DATABASE_URL;
  if (!base) return null;
  const u = new URL(base);
  u.pathname = `${u.pathname.replace(/\/$/, "")}_test`;
  return u.toString();
}
