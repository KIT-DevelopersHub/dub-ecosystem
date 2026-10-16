// Standalone Playwright E2E for 運営名簿の行クリック編集, run with `node` against a VITE_DEMO
// build (E2E_FE2, e.g. a disposable demo URL). Navigates by clicks from home, clicks a row
// (not the 操作 column), edits 担当・役割, saves, and checks the table reflects the change.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const FE2 = process.env.E2E_FE2 ?? "http://localhost:5312";
const OUT = process.env.E2E_OUT ?? "/tmp/roster-row-edit-e2e";
mkdirSync(OUT, { recursive: true });
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { throw new Error(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text()); });

try {
  await page.goto(FE2, { waitUntil: "networkidle" });
  await page.locator('a[href="/members"]').first().click();
  await page.getByTestId("members-page").waitFor({ timeout: 15000 });
  await page.getByTestId("member-roster-subnav").getByRole("tab", { name: "運営名簿" }).first().click();
  await page.getByTestId("member-roster-page").waitFor({ timeout: 15000 });
  const table = page.getByTestId("members-table");
  await table.waitFor();
  await page.getByText("行をクリックすると情報を編集できます").waitFor();
  ok("reached 運営名簿 with the row-click hint");
  await page.screenshot({ path: join(OUT, "before.png") });

  const row = table.locator("tbody tr").first();
  await row.locator("td").first().click();
  const dialog = page.getByTestId("members-form-dialog");
  await dialog.waitFor({ timeout: 5000 });
  if (!(await dialog.getByText("メンバーを編集").isVisible())) fail("dialog is not in edit mode");
  ok("row click opened the edit dialog");

  const role = `E2E役割${Date.now() % 10000}`;
  await dialog.locator("#member-role").fill(role);
  await page.screenshot({ path: join(OUT, "dialog.png") });
  await dialog.getByTestId("members-form-submit").click();
  await dialog.waitFor({ state: "detached", timeout: 5000 }).catch(() => dialog.waitFor({ state: "hidden", timeout: 5000 }));
  await table.getByText(role).waitFor({ timeout: 5000 });
  ok(`saved and the table shows 担当・役割 = ${role}`);

  const linkBtn = table.locator('[data-testid^="members-link-"]').first();
  if (await linkBtn.count()) {
    await linkBtn.click();
    await page.waitForTimeout(300);
    if (await dialog.isVisible()) fail("row button (紐付け) also opened the edit dialog");
    ok("row button (紐付け) does not open the edit dialog");
  }
  await page.screenshot({ path: join(OUT, "after.png") });
  ok("all checks passed");
} finally {
  await browser.close();
}
