// Real-browser E2E for the メール名簿 20件ページ切り替え on the per-feature demo (VITE_DEMO seed).
import { chromium } from "@playwright/test";

const BASE = process.env.E2E_BASE || "https://dub-demo-roster-pagination.developershub-site.workers.dev";
const OUT = process.env.E2E_OUT || "/tmp/roster-pg-e2e";
const assert = (c, m) => { if (!c) throw new Error("ASSERT FAILED: " + m); console.log("  ok:", m); };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
try {
  await page.goto(BASE + "/admin/users", { waitUntil: "networkidle" });
  await page.getByTestId("fe7-users-table").waitFor({ timeout: 20000 });
  const count = page.getByTestId("fe7-users-count");
  const rows = () => page.locator('[data-testid="fe7-users-table"] tbody tr').count();
  const total = Number(/全 (\d+)件/.exec(await count.innerText())[1]);
  const pages = Math.ceil(total / 20);
  assert(total > 40, "全件数が3ページ分ある: " + total);
  assert((await count.innerText()).includes("（1〜20件目）"), "1ページ目: " + (await count.innerText()));
  assert((await rows()) === 20, "1ページ目は20行");
  assert((await page.getByText("さらに読み込む").count()) === 0, "「さらに読み込む」ボタンが無い");
  const pager = page.getByTestId("fe7-users-pagination");
  assert((await pager.innerText()).includes(`1 / ${pages}`), "ページ表示 1 / " + pages);
  const pagerBox = await pager.boundingBox();
  const tableBox = await page.getByTestId("fe7-users-table").boundingBox();
  assert(pagerBox.y + pagerBox.height <= tableBox.y, "ページ送りは表の上にある");
  assert(pagerBox.y + pagerBox.height <= 900, "ページ送りはスクロール無しで見える");
  await page.screenshot({ path: OUT + "/01-page1.png", fullPage: true });

  await pager.getByLabel("次のページ").click();
  assert((await count.innerText()).includes("（21〜40件目）"), "2ページ目: " + (await count.innerText()));
  assert((await pager.innerText()).includes(`2 / ${pages}`), "ページ表示 2 / " + pages);
  await page.screenshot({ path: OUT + "/02-page2.png", fullPage: true });

  await pager.getByLabel("次のページ").click();
  assert((await count.innerText()).includes(`（41〜${total}件目）`), "3ページ目: " + (await count.innerText()));
  assert((await rows()) === total - 40, "3ページ目は残り" + (total - 40) + "行");
  assert(await pager.getByLabel("次のページ").isDisabled(), "最終ページで「次」は押せない");
  await page.screenshot({ path: OUT + "/03-page3.png", fullPage: true });

  await page.getByTestId("fe7-users-search").fill("メンバー 0");
  await page.waitForTimeout(800);
  assert((await count.innerText()).startsWith(`${total}件中 9件を表示`), "検索で1ページ目に戻り件数が絞られる: " + (await count.innerText()));
  assert((await pager.count()) === 0, "1ページに収まる時はページ送りを出さない");
  await page.screenshot({ path: OUT + "/04-search.png", fullPage: true });
  assert(errors.length === 0, "ページエラーなし " + errors.join(" | "));
  console.log("PASS");
} finally {
  await browser.close();
}
