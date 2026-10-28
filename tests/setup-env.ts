import { testDatabaseUrl } from "./test-db-url";

// Tests never touch the development database and never call external services.
const url = testDatabaseUrl();
if (url) process.env.DATABASE_URL = url;
process.env.OPENAI_API_KEY = "test-key-not-used"; // OpenAI client is mocked in tests that need it
process.env.PHI_EXTERNAL_AI_APPROVED = "false";
process.env.APP_ENV = "test";
process.env.CRON_SECRET = "";
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-test-secret-test-secret";
