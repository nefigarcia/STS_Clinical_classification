import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

/** Creates a throwaway admin via the CLI (local DB only) and walks the full password flow. */
function createAdmin(email: string): string {
  const out = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/create-admin.ts", email, "E2E Admin"], { encoding: "utf8" });
  const m = out.match(/Temporary password \(shown once\): (\S+)/);
  if (!m) throw new Error("create-admin did not print a temporary password");
  return m[1];
}

test("password account: temporary password → forced change → sign in with new password", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.org`;
  const temp = createAdmin(email);
  const newPassword = "Tidal-Granite-47!";

  // Wrong password is rejected with a generic message.
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Wrong-Password-1");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(/Invalid email or password/)).toBeVisible();

  // Temporary password signs in but only allows changing it.
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(temp);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/change-password/);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/change-password/);

  await page.getByLabel("Temporary password").fill(temp);
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page).toHaveURL(/\/sign-in\?notice=password-changed/);
  await expect(page.getByText("Password changed")).toBeVisible();

  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(newPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Change password" })).toBeVisible();
});
