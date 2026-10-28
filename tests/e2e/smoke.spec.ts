import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

async function devLogin(page: Page, role: "Admin" | "Reviewer" | "Read-only") {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: role, exact: true }).click();
  await page.waitForURL("**/dashboard");
}

test("unauthenticated users are redirected to sign-in and APIs return 401", async ({ page, request }) => {
  await page.goto("/patients");
  await expect(page).toHaveURL(/\/sign-in/);
  expect((await request.get("/api/patients")).status()).toBe(401);
  expect((await request.get("/api/health")).status()).toBe(200);
});

test("reviewer can upload synthetic data, search and open the review screen", async ({ page }) => {
  await devLogin(page, "Reviewer");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText(/no approved STS CHSD Training Manual/i).first()).toBeVisible();

  // Upload wizard with synthetic CSV (written by `npm run seed:synthetic`).
  await page.getByRole("link", { name: "Upload Data" }).first().click();
  await page.locator('input[type="file"]').setInputFiles(path.join("tests", "fixtures", "synthetic-notes.csv"));
  await page.getByRole("button", { name: /Upload and preview/ }).click();
  await expect(page.getByText(/11 rows detected/)).toBeVisible();
  await page.getByRole("button", { name: /^Validate/ }).click();
  await expect(page.getByRole("heading", { name: "Import report" })).toBeVisible();
  await expect(page.getByText("Invalid rows").locator("..")).toContainText("2");
  await page.getByRole("button", { name: /Import \d+ valid rows/ }).click();
  await expect(page.getByRole("heading", { name: "Import complete" })).toBeVisible();

  // Patient search with partial identifier match, preserving leading zeros.
  await page.goto("/patients");
  await page.getByLabel("Search encounters").fill("00500");
  await expect(page).toHaveURL(/q=00500/);
  await expect(page.getByRole("cell", { name: "00600202" })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "00500101" })).toBeVisible();
  await page
    .getByRole("table")
    .getByRole("link", { name: /Open|Review/ })
    .first()
    .click();
  await expect(page.getByText("Clinical notes (5)")).toBeVisible();
  await expect(page.getByLabel("Clinical note text")).toContainText("SYNTHETIC");
  await expect(page.getByRole("button", { name: /Add missing complication/ })).toBeVisible();
  await page.getByRole("link", { name: /Back to results/ }).click();
  await expect(page).toHaveURL(/q=00500/);
});

test("read-only users cannot reach upload or start jobs", async ({ page, request }) => {
  await devLogin(page, "Read-only");
  await page.goto("/upload");
  await expect(page).toHaveURL(/dashboard\?forbidden=1/);
  const res = await page.request.post("/api/jobs", { data: { scope: "all" } });
  expect(res.status()).toBe(403);
  void request;
});

test("knowledge base shows STS classification unavailable without a manual", async ({ page }) => {
  await devLogin(page, "Admin");
  await page.goto("/knowledge-base");
  await expect(page.getByText(/STS-based classification is unavailable/)).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByText("Safety gates")).toBeVisible();
  await page.goto("/validation");
  await expect(page.getByText(/Development diagnostics only/)).toBeVisible();
});
