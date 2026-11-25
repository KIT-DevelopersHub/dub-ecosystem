// Playwright E2E: 組織図 (法人チーム非表示・打診中/休み中は下・印刷が A4 横 1 枚いっぱい) +
// 運営名簿の催促 + メール名簿のロール絞り込みを、本番ビルドの demo で確認する。
// Usage: E2E_BASE=http://localhost:4391 E2E_SHOTS=/tmp/x node e2e/members-org-chart-print.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = process.env.E2E_BASE ?? "http://localhost:4319";
const SHOTS = process.env.E2E_SHOTS ?? join(tmpdir(), "members-org-chart-e2e");
mkdirSync(SHOTS, { recursive: true });
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { throw new Error(m); };

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // ---- 組織図 ----
  await page.goto(`${BASE}/members/org-chart`);
  const chart = page.getByTestId("members-orgchart");
  await chart.waitFor({ timeout: 20000 });
  await page.screenshot({ path: join(SHOTS, "01-org-chart.png"), fullPage: true });
  if ((await page.getByTestId("members-orgcol-team_corp").count()) !== 0) fail("法人チームの列が出ている");
  ok("法人チームの列が無い");

  // ツリーの各階層(ul)の中で、兄弟の並びが 活動中 → 打診中/休み中 になっていること。
  const misordered = await page.locator("[data-testid^=members-orgcol-] ul").evaluateAll((uls) =>
    uls.filter((ul) => {
      const ranks = [...ul.children].map((li) => (/打診中|休み中/.test(li.firstElementChild?.textContent ?? "") ? 1 : 0));
      return ranks.join("") !== [...ranks].sort().join("");
    }).length,
  );
  if (misordered > 0) fail(`活動中の上に打診中/休み中がいる階層: ${misordered}`);
  ok("全階層で打診中/休み中が活動中の下にある");

  await page.emulateMedia({ media: "print" });
  const pdf = join(SHOTS, "org-chart.pdf");
  await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: "screen" });
  ok(`PDF 出力: ${pdf}`);

  // ---- 運営名簿の催促 ----
  await page.goto(`${BASE}/members/roster`);
  await page.getByTestId("member-roster-page").waitFor({ timeout: 20000 });
  await page.getByTestId("member-roster-profile-filter").selectOption("missing");
  const remind = page.getByTestId("member-roster-remind");
  const label = (await remind.textContent()) ?? "";
  if (!/（[1-9]\d*人）/.test(label)) fail(`催促の対象が 0 人: ${label}`);
  ok(`催促ボタン = ${label}`);
  await remind.click();
  const dlg = page.getByTestId("member-roster-confirm-remind");
  await dlg.waitFor();
  await page.screenshot({ path: join(SHOTS, "02-remind-confirm.png") });
  await dlg.getByRole("button", { name: "催促を送る" }).click();
  await page.getByText(/入力の催促を送りました/).first().waitFor({ timeout: 8000 });
  ok("催促の完了トーストが出た");
  await page.screenshot({ path: join(SHOTS, "03-roster-missing.png") });

  // ---- メール名簿のロール絞り込み ----
  await page.goto(`${BASE}/admin/users`);
  const role = page.getByTestId("fe7-users-role-filter");
  await role.waitFor({ timeout: 20000 });
  await page.getByTestId("fe7-users-count").waitFor();
  const before = await page.getByTestId("fe7-users-count").textContent();
  const opt = await role.locator("option").nth(1).getAttribute("value");
  await role.selectOption(opt);
  await page.waitForFunction((b) => document.querySelector('[data-testid="fe7-users-count"]')?.textContent !== b, before);
  ok(`ロール絞り込み: ${before} -> ${await page.getByTestId("fe7-users-count").textContent()}`);
  if (!page.url().includes("role=")) fail("絞り込みが URL に残らない");
  await page.screenshot({ path: join(SHOTS, "04-mail-roster-role.png"), fullPage: true });

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log("PASS");
} finally {
  await browser.close();
}
