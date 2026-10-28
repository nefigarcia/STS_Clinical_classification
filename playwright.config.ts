import { defineConfig, devices } from "@playwright/test";

/**
 * E2E smoke tests run against the local app (synthetic data + dev login).
 * Start the db first (`docker compose up -d && npm run db:migrate && npm run seed:synthetic`).
 * Requires AUTH_DEV_LOGIN_ENABLED=true in .env. Never point this at an environment with PHI.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "npm run start", url: "http://localhost:3000/api/health", reuseExistingServer: true, timeout: 120_000 },
});
