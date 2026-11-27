// Standalone Playwright check for #901 運営メンバー の表示切り替え, run with `node`
// against a VITE_DEMO build (E2E_FE2). Saves screenshots to E2E_OUT.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const FE2 = process.env.E2E_FE2 ?? "http://localhost:5312";
const OUT = process.env.E2E_OUT ?? "/tmp/members-view-switch-e2e";
mkdirSync(OUT, { recursive: true });
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { throw new Error(m); };
// 見出しは表示に関わらず「運営メンバー」、どの表示かは説明文の先頭で伝える。
async function checkHeader(page, testId, view) {
  const header = page.getByTestId(testId).locator("header").first();
  const title = (await header.locator("h1").first().textContent())?.trim();
  if (title !== "運営メンバー") fail(`${view}: heading = ${title}`);
  const text = await header.textContent();
  if (!text?.includes(`${view}で表示中。`)) fail(`${view}: description missing「${view}で表示中」`);
}

const browser = await chromium.launch();
try {
  for (const [label, viewport] of [["desktop", { width: 1360, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text()); });
    await page.goto(FE2, { waitUntil: "networkidle" });
    await page.goto(`${FE2}/members`, { waitUntil: "networkidle" });
    await page.getByTestId("members-page").waitFor({ timeout: 20000 });

    const tabs = await page.getByTestId("member-roster-subnav").getByRole("tab").allTextContents();
    if (tabs.join("|") !== "運営メンバー|メール名簿") fail(`tabs: ${tabs.join("|")}`);
    ok(`${label}: tabs = ${tabs.join(" / ")}`);
    await checkHeader(page, "members-page", "チーム別");
    ok(`${label}: チーム別 heading = 運営メンバー`);
    await page.screenshot({ path: join(OUT, `${label}-1-teams.png`) });

    await page.getByTestId("members-view-switch-table").click();
    await page.getByTestId("member-roster-page").waitFor();
    if ((await page.getByTestId("members-view-switch-table").getAttribute("aria-selected")) !== "true") fail("table not selected");
    if (!page.url().endsWith("/members/roster")) fail(`url ${page.url()}`);
    ok(`${label}: 一覧表 → /members/roster`);
    await checkHeader(page, "member-roster-page", "一覧表");
    ok(`${label}: 一覧表 heading = 運営メンバー`);
    await page.screenshot({ path: join(OUT, `${label}-2-table.png`) });

    await page.getByTestId("members-view-switch-org-chart").click();
    await page.getByTestId("members-orgchart-page").waitFor();
    ok(`${label}: 組織図 → /members/org-chart`);
    await checkHeader(page, "members-orgchart-page", "組織図");
    ok(`${label}: 組織図 heading = 運営メンバー`);
    await page.screenshot({ path: join(OUT, `${label}-3-org.png`) });

    // メール名簿へ移って、運営メンバータブを押し直すと最後に選んだ表示(組織図)に戻る。
    await page.getByTestId("member-roster-subnav").getByRole("tab", { name: "メール名簿" }).click();
    await page.waitForURL(/\/admin\/users/);
    if (await page.getByTestId("members-view-switch").count()) fail("switch shown on メール名簿");
    await page.screenshot({ path: join(OUT, `${label}-4-mail.png`) });
    await page.getByTestId("member-roster-subnav").getByRole("tab", { name: "運営メンバー" }).click();
    await page.getByTestId("members-orgchart-page").waitFor();
    ok(`${label}: タブを押し直すと最後の表示(組織図)に戻る`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) console.log(`  warn: ${label} horizontal overflow`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
