// 運営メンバーの範囲 (組織図まで / メール名簿以外 / 全て) を demo の実ブラウザで確かめる。
//   BASE_URL=https://fe2-demo.developershub-site.workers.dev node e2e/members-scope-demo.mjs
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "https://fe2-demo.developershub-site.workers.dev";
const SHOT = process.env.SHOT_DIR ?? "/tmp/members-scope";
const browser = await chromium.launch();
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
};

async function tabs(account) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const calls = [];
  page.on("request", (r) => {
    const p = new URL(r.url()).pathname;
    if (p.includes("/members/")) calls.push(p);
  });
  await page.goto(`${BASE}/members?demo_account=${account}`, { waitUntil: "networkidle" });
  await page.getByTestId("member-roster-subnav").waitFor({ timeout: 20000 });
  const labels = await page.getByTestId("member-roster-subnav").getByRole("tab").allTextContents();
  await page.screenshot({ path: `${SHOT}-${account}.png` });
  return { page, labels, calls };
}

const expectTabs = {
  usr_scope_org: ["運営メンバー", "組織図"],
  usr_scope_roster: ["運営メンバー", "組織図", "運営名簿"],
  usr_demo: ["運営メンバー", "組織図", "運営名簿", "メール名簿"],
};
for (const [account, want] of Object.entries(expectTabs)) {
  const { page, labels } = await tabs(account);
  check(`${account} のタブ`, JSON.stringify(labels) === JSON.stringify(want), labels.join(" / "));
  await page.close();
}

// 組織図まで: 直リンクは開けず、編集ダイアログに本人の情報が出ない。
{
  const { page } = await tabs("usr_scope_org");
  await page.getByTestId("members-page").waitFor();
  await page.getByRole("button", { name: /を編集$/ }).nth(1).click();
  await page.getByTestId("members-form-dialog").waitFor();
  check("組織図まで: 編集に本人の情報が無い", (await page.getByTestId("members-form-profile-section").count()) === 0);
  await page.screenshot({ path: `${SHOT}-org-edit.png` });
  await page.goto(`${BASE}/members/roster?demo_account=usr_scope_org`, { waitUntil: "networkidle" });
  check("組織図まで: 運営名簿の直リンクは開かない", (await page.getByTestId("member-roster-page").count()) === 0);
  await page.goto(`${BASE}/admin/users?demo_account=usr_scope_org`, { waitUntil: "networkidle" });
  check("組織図まで: メール名簿の直リンクは開かない", (await page.getByTestId("fe7-users-header").count()) === 0);
  await page.close();
}

// 全て: メール名簿は開ける (上の否定が testid 違いで素通りしていないことの確認も兼ねる)。
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${BASE}/admin/users?demo_account=usr_demo`, { waitUntil: "networkidle" });
  await page.getByTestId("fe7-users-header").waitFor({ timeout: 20000 });
  check("全て: メール名簿が開く", true);
  await page.close();
}

// メール名簿以外: 運営名簿は開ける。
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${BASE}/members/roster?demo_account=usr_scope_roster`, { waitUntil: "networkidle" });
  check("メール名簿以外: 運営名簿が開く", (await page.getByTestId("member-roster-page").count()) === 1);
  await page.close();
}

// ロール管理: 範囲の選択肢と鍵の連動。
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await page.goto(`${BASE}/admin/roles`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "運営メンバー の詳細設定を開く" }).first().waitFor({ timeout: 20000 });
  await page.screenshot({ path: `${SHOT}-roles.png`, fullPage: true });
  await page.getByRole("button", { name: "運営メンバー の詳細設定を開く" }).first().click();
  const section = page.locator('div[data-testid$="-members-scope"]');
  await section.waitFor();
  const text = await section.textContent();
  check("ロール管理: 3 段が閲覧・編集の両方にある", ["組織図まで", "メール名簿以外", "全て"].every((l) => text.split(l).length === 3), "");
  // 編集を 組織図まで に狭めても閲覧は残る / 閲覧を狭めると編集も狭まる。
  const editOrg = page.locator('[data-testid$="-members-scope-edit-org_chart"]');
  const viewOrg = page.locator('[data-testid$="-members-scope-view-org_chart"]');
  const viewAll = page.locator('[data-testid$="-members-scope-view-all"]');
  await editOrg.click();
  check("編集を狭めても閲覧は全てのまま", (await viewAll.getAttribute("aria-selected")) === "true");
  await page.locator('[data-testid$="-members-scope-edit-all"]').click();
  await viewOrg.click();
  check("閲覧を狭めると編集も狭まる", (await editOrg.getAttribute("aria-selected")) === "true");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOT}-dialog.png` });
  await page.close();
}

await browser.close();
if (results.includes(false)) process.exit(1);
console.log(`ALL PASS (${results.length})`);
