// Standalone Playwright E2E for the roster×member整合 features (#1/#2/#5), run directly
// with `node` against two VITE_DEMO dev servers:
//   fe2 (運営メンバー管理)  on E2E_FE2 (default http://localhost:5312)
//   fe7 (管理ロスター)      on E2E_FE7 (default http://localhost:5313)
// Screenshots → ~/DubVault/docs/roster-link-review/. Drives stable data-testids only.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FE2 = process.env.E2E_FE2 ?? "http://localhost:5312";
const FE7 = process.env.E2E_FE7 ?? "http://localhost:5313";
const SHOTS = join(homedir(), "DubVault/docs/roster-link-review");
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: true });
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { throw new Error(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text()); });

try {
  // ============ #1: link 運営メンバー -> identity account (fe2) ============
  await page.goto(`${FE2}/members`, { waitUntil: "networkidle" });
  await page.getByTestId("members-page").waitFor({ timeout: 15000 });
  // 高岡 (member_1) is seeded linked; 黒川 (member_h2) is unlinked with a 紐付け button.
  await page.getByTestId("members-account-member_1").waitFor({ timeout: 10000 });
  ok("#1 seeded linked account visible (member_1)");
  await page.getByTestId("members-link-member_h2").waitFor();
  await shot(page, "01-members-list-account-column.png");

  await page.getByTestId("members-link-member_h2").click();
  await page.getByTestId("members-link-dialog").waitFor();
  await page.getByTestId("members-link-candidates").waitFor();
  await page.waitForTimeout(500);
  await shot(page, "02-link-candidate-picker.png");

  // pick the first SELECTABLE candidate (skip accounts already linked to someone), then confirm.
  const firstOption = page.locator('[data-testid^="members-link-option-"]:not([disabled])').first();
  await firstOption.click();
  await page.getByTestId("members-link-confirm").click();
  await page.getByTestId("members-account-member_h2").waitFor({ timeout: 10000 });
  ok("#1 member_h2 now shows a linked account");
  await shot(page, "03-link-applied.png");

  // ============ #5: Email Routing sync diff preview (fe7) ============
  await page.goto(`${FE7}/admin/users`, { waitUntil: "networkidle" });
  await page.getByTestId("fe7-users-table").waitFor({ timeout: 15000 });
  await page.getByTestId("fe7-users-sync").click();
  await page.getByTestId("fe7-sync-preview").waitFor({ timeout: 10000 });
  await page.getByTestId("fe7-sync-preview-summary").waitFor();
  ok("#5 preview dialog shows the diff before applying");
  await page.waitForTimeout(500);
  await shot(page, "04-sync-preview.png");
  // roster is still unchanged until apply.
  if (await page.getByTestId("fe7-users-table").locator("text=info@developershub.jp").count()) {
    fail("#5 roster changed BEFORE apply — preview must be read-only");
  }
  await page.getByTestId("fe7-sync-apply").click();
  await page.getByTestId("fe7-users-table").locator("text=info@developershub.jp").first().waitFor({ timeout: 10000 });
  ok("#5 apply added the addresses as roster rows");
  await shot(page, "05-sync-applied.png");

  // ============ #2: one-shot offboarding (fe7) ============
  await page.goto(`${FE7}/admin/users`, { waitUntil: "networkidle" });
  await page.getByTestId("fe7-users-table").waitFor({ timeout: 15000 });
  await page.getByTestId("fe7-users-open-user_bob").click();
  await page.getByTestId("fe7-user-inline-user_bob").waitFor();
  await page.getByTestId("fe7-user-offboard").waitFor();
  await shot(page, "06-user-detail-offboard-button.png");

  await page.getByTestId("fe7-user-offboard").click();
  await page.getByTestId("fe7-user-offboard-confirm").waitFor();
  await page.getByTestId("fe7-user-offboard-confirm").getByRole("button", { name: "オフボードする" }).click();
  await page.getByTestId("fe7-user-offboard-result").waitFor({ timeout: 10000 });
  // all three step rows present (identity / member-status / email-routing).
  for (const step of ["identity", "member-status", "email-routing"]) {
    await page.getByTestId(`fe7-offboard-step-${step}`).waitFor({ timeout: 5000 });
  }
  ok("#2 offboard ran all three steps with a results panel");
  await page.waitForTimeout(400);
  await shot(page, "07-offboard-result.png");

  console.log("\nALL E2E FLOWS PASSED — screenshots in", SHOTS);
} catch (e) {
  await shot(page, "zz-failure.png").catch(() => {});
  console.error("E2E FAILED:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
