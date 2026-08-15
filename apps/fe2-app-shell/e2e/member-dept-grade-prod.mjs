// Standalone Playwright E2E for PR #195 (運営メンバー 学科/学年 カラム), run against a
// PRODUCTION build served by `vite preview` in VITE_DEMO mode. Verifies:
//   (a) the prod build is NOT a white screen (members-page renders)
//   (b) admin: 学科/学年 show in 一覧 / 編集ダイアログ / 検索 / 組織図
//   (c) 一般メンバー (usr_member): the 運営メンバー tile is greyed (admin限定) and a
//       direct deep-link is release-gated (fe2-forbidden), NOT the working page.
// Screenshots -> ~/DubVault/docs/member-prod-e2e/. Drives stable data-testids only.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:4319";
const SHOTS = join(homedir(), "DubVault/docs/member-prod-e2e");
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: true });
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { throw new Error(m); };

const browser = await chromium.launch();
try {
  // ============ (a)+(b) admin session (default demo account) ============
  const adminCtx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const page = await adminCtx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(`${BASE}/members`, { waitUntil: "networkidle" });
  await page.getByTestId("members-page").waitFor({ timeout: 20000 });
  await page.getByTestId("members-table").waitFor({ timeout: 15000 });
  // white-screen guard: real text content present in the body.
  const bodyText = (await page.locator("body").innerText()).trim();
  if (bodyText.length < 50) fail(`(a) white/blank screen — body text length ${bodyText.length}`);
  ok("(a) prod build renders 運営メンバー (not white)");

  // (b1) 一覧 columns 学科/学年 present, and seeded 高岡 row shows real values.
  const table = page.getByTestId("members-table");
  await table.getByRole("columnheader", { name: "学科" }).waitFor();
  await table.getByRole("columnheader", { name: "学年" }).waitFor();
  if (!(await table.getByText("情報工学科").first().count())) fail("(b) 学科 value 情報工学科 not in 一覧");
  if (!(await table.getByText("3年").first().count())) fail("(b) 学年 value 3年 not in 一覧");
  ok("(b1) 一覧 has 学科/学年 columns + seeded values");
  await shot(page, "01-admin-list-columns.png");

  // (b2) 検索 filters by 学科/学年. Search a dept only some members have.
  await page.getByTestId("members-search").fill("電気電子");
  await page.waitForTimeout(400);
  if (!(await table.getByText("電気電子工学科").first().count())) fail("(b) 検索 電気電子 returned no 電気電子工学科 row");
  if (await table.getByText("情報工学科").first().count()) fail("(b) 検索 電気電子 did NOT filter out 情報工学科 rows");
  ok("(b2) 検索 filters by 学科");
  await shot(page, "02-admin-search-dept.png");
  await page.getByTestId("members-search").fill("");
  await page.waitForTimeout(300);

  // (b3) 編集ダイアログ shows 学科/学年 fields prefilled for 高岡 (member_1).
  await page.getByTestId("members-edit-member_1").click();
  await page.getByTestId("members-form-dialog").waitFor({ timeout: 10000 });
  const dept = await page.getByTestId("members-form-department").inputValue();
  const grade = await page.getByTestId("members-form-grade").inputValue();
  if (dept !== "情報工学科") fail(`(b) 編集 学科 field = "${dept}", expected 情報工学科`);
  if (grade !== "3年") fail(`(b) 編集 学年 field = "${grade}", expected 3年`);
  ok("(b3) 編集ダイアログ prefilled 学科/学年");
  await shot(page, "03-admin-edit-dialog.png");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // (b4) 組織図 tab renders and shows the 学年 on a team-column member chip.
  // (The compact 統括 HQ box shows names only by design; 学年 appears on team chips.)
  await page.getByTestId("members-tabs").getByRole("tab", { name: "組織図" }).click();
  await page.getByTestId("members-orgchart").waitFor({ timeout: 10000 });
  const chip = page.getByTestId("members-orgchip-member_d1").first(); // 荒木 / 開発 / M1
  await chip.waitFor();
  if (!(await chip.getByText("M1").count())) fail("(b) 組織図 chip for 荒木 missing 学年 M1");
  ok("(b4) 組織図 shows 学年 on a team-column member chip");
  await shot(page, "04-admin-orgchart.png");
  await adminCtx.close();

  // ============ (c) 一般メンバー session — release gate ============
  const memberCtx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const mp = memberCtx.newPage ? await memberCtx.newPage() : null;
  // Seed the demo account switch BEFORE the app boots.
  await memberCtx.addInitScript(() => {
    try { localStorage.setItem("dub_demo_account", "usr_member"); } catch (_) {}
  });
  const page2 = mp ?? (await memberCtx.newPage());
  // land on home so the launcher is available; confirm we are the member account.
  await page2.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page2.waitForTimeout(800);

  // (c1) open the app launcher and assert the 運営メンバー tile is disabled (greyed).
  await page2.getByTestId("fe2-app-launcher-trigger").click();
  const tile = page2.getByTestId("fe2-app-launcher-item-members");
  await tile.waitFor({ timeout: 10000 });
  const disabled = await tile.getAttribute("aria-disabled");
  const isDisabledProp = await tile.isDisabled().catch(() => false);
  if (disabled !== "true" && !isDisabledProp) fail(`(c) 運営メンバー tile not greyed for member (aria-disabled=${disabled}, disabled=${isDisabledProp})`);
  ok("(c1) 運営メンバー tile greyed/disabled for 一般メンバー");
  await shot(page2, "05-member-launcher-greyed.png");

  // (c2) direct deep-link is release-gated -> fe2-forbidden, not the working page.
  await page2.goto(`${BASE}/members`, { waitUntil: "networkidle" });
  await page2.waitForTimeout(500);
  await page2.getByTestId("fe2-forbidden").waitFor({ timeout: 10000 });
  if (await page2.getByTestId("members-table").count()) fail("(c) member reached the working members-table (gate bypassed!)");
  ok("(c2) deep-link /members -> fe2-forbidden for 一般メンバー");
  await shot(page2, "06-member-deeplink-forbidden.png");
  await memberCtx.close();

  if (consoleErrors.length) {
    console.log(`  [warn] ${consoleErrors.length} console error(s) during admin flow:`);
    for (const e of consoleErrors.slice(0, 8)) console.log("    -", e);
  }
  console.log("\nALL CHECKS PASSED");
} finally {
  await browser.close();
}
