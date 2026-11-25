// Playwright E2E: 採用後に辞退した人は削除でき、採用中の人は削除できない (名簿は残る)。
// Usage: E2E_BASE=https://fe2-demo.developershub-site.workers.dev node e2e/hr-remove-withdrawn-demo.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:4319";
const SHOTS = process.env.E2E_SHOTS ?? join(tmpdir(), "hr-remove-withdrawn-e2e");
mkdirSync(SHOTS, { recursive: true });
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => {
  throw new Error(m);
};

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/hr`, { waitUntil: "networkidle" });
  const left = page.getByTestId("fe2-hr-row-app_demo_11-remove");
  await left.waitFor({ timeout: 20000 });
  if (await left.isDisabled()) fail("採用後に辞退した人の削除ボタンが disabled");
  ok("採用後に辞退した人の削除ボタンが押せる");
  if (!(await page.getByTestId("fe2-hr-row-app_demo_7-remove").isDisabled())) fail("採用中の人の削除ボタンが押せてしまう");
  ok("採用中の人の削除ボタンは disabled のまま");
  await page.screenshot({ path: join(SHOTS, "01-list.png"), fullPage: true });

  await left.click();
  const dialog = page.getByTestId("fe2-hr-remove-confirm");
  await dialog.getByText("名簿の登録は解除されません").waitFor({ timeout: 5000 });
  ok("確認ダイアログが名簿は残ると伝える");
  await page.screenshot({ path: join(SHOTS, "02-confirm.png"), fullPage: true });
  await dialog.getByRole("button", { name: "削除する" }).click();
  await page.getByTestId("fe2-hr-row-app_demo_11").waitFor({ state: "detached", timeout: 5000 });
  await page.getByText("野村 蓮 さんの応募を削除しました").waitFor({ timeout: 5000 });
  ok("確定すると一覧から消える");
  await page.waitForTimeout(800);
  if ((await page.getByTestId("fe2-hr-row-app_demo_11").count()) !== 0) fail("削除した行が戻った");
  ok("失敗で戻らない");
  await page.screenshot({ path: join(SHOTS, "03-removed.png"), fullPage: true });

  if (errors.length) fail(`pageerror: ${errors.join("; ")}`);
  console.log(`PASS (shots: ${SHOTS})`);
} finally {
  await browser.close();
}
