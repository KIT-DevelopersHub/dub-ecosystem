// Playwright E2E: 運営名簿の表に参加届の回答一覧と同じ人物項目の列が既定で並ぶことを live demo で確認する。
// Home -> 運営メンバー -> 運営名簿 の列見出し と 参加届の回答一覧 の列見出し を比べる。
// Usage: E2E_BASE=https://dub-demo-roster-number.developershub-site.workers.dev node e2e/roster-columns-match-participation-demo.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:4319";
const SHOTS = join(homedir(), "DubVault/docs/roster-columns-e2e");
mkdirSync(SHOTS, { recursive: true });
const fail = (m) => { throw new Error(m); };

// 参加届の回答一覧のうち人物項目ではない列 (残りが PersonProfile 由来の列)。
const PARTICIPATION_ONLY = ["運営メンバー反映", "氏名", "希望チーム", "提出日時"];
const headersOf = async (page, testId) =>
  (await page.getByTestId(testId).locator("th").allTextContents()).map((t) => t.trim());

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.locator('a[href="/members"]').first().click();
  await page.getByTestId("member-roster-subnav-tab-member-roster").click();
  await page.getByTestId("members-table").waitFor();
  const roster = await headersOf(page, "members-table");
  await page.screenshot({ path: join(SHOTS, "roster.png"), fullPage: true });

  await page.getByTestId("member-roster-subnav-tab-participation-list").click();
  await page.getByTestId("participation-list-table").waitFor();
  const part = await headersOf(page, "participation-list-table");

  console.log("  運営名簿:", roster.join(" | "));
  console.log("  参加届  :", part.join(" | "));
  // 参加届固有の列を除いたものが人物項目の列。
  const profile = part.filter((t) => t !== "" && !PARTICIPATION_ONLY.includes(t));
  if (!profile.some((t) => t.includes("Gmail"))) fail("参加届の回答一覧に Gmail 列がない");
  const missing = profile.filter((h) => !roster.includes(h));
  if (missing.length) fail(`運営名簿の表に無い列: ${missing.join(", ")}`);
  const inRoster = roster.filter((t) => profile.includes(t));
  if (JSON.stringify(inRoster) !== JSON.stringify(profile)) fail("人物項目の列の並び順が違う");
  console.log(`  ok: 人物項目 ${profile.length} 列が両方の表に同じ順で並ぶ`);
  if (errors.length) fail(`page errors: ${errors.join("; ")}`);
  console.log("PASS");
} finally {
  await browser.close();
}
