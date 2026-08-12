// Standalone node Playwright E2E proving the 運営メンバー管理 三ビュー(一覧/チーム別/組織図)
// all render from ONE data source (useMembersOverview / demo transport). Not part of the
// @playwright/test runner — run directly with `node`, against a vite --port 5210 dev
// server (VITE_DEMO=1, auto-login). Works purely off stable data-testids (member id /
// team id), so it does not depend on @dub/ui internal DOM. Asserts:
//   (a) 一覧 の非辞退メンバー id 集合 == 組織図 の chip id 集合
//   (b) 一覧でメンバー追加 → 組織図に即反映（chip 数 +1・氏名が出る）
//   (c) チーム別 各チームの行数 == 組織図 各チーム「計N名」
// Screenshots → ~/DubVault/docs/members-orgsync-review/.
// chromium re-exported by @playwright/test (the `playwright` pkg is not a direct dep here).
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:5210";
const SHOTS = join(homedir(), "DubVault/docs/members-orgsync-review");
mkdirSync(SHOTS, { recursive: true });

const shot = (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: true });
const fail = (msg) => { throw new Error(msg); };
const eqSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

const TAB_TID = { "一覧": "members-tabs-tab-list", "チーム別": "members-tabs-tab-teams", "組織図": "members-tabs-tab-org" };
async function gotoTab(page, label) {
  await page.getByTestId(TAB_TID[label]).click();
  await page.waitForTimeout(200);
}

// Collect the trailing id of every element whose data-testid starts with `prefix`.
async function idsWithPrefix(scope, prefix) {
  const loc = scope.locator(`[data-testid^="${prefix}"]`);
  const n = await loc.count();
  const ids = [];
  for (let i = 0; i < n; i++) {
    const tid = await loc.nth(i).getAttribute("data-testid");
    if (tid) ids.push(tid.slice(prefix.length));
  }
  return ids;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await page.goto(`${BASE}/members`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="members-page"]', { timeout: 30_000 });

  // ---- 一覧: member ids + which are 辞退(declined) ----
  await gotoTab(page, "一覧");
  await page.waitForSelector('[data-testid="members-table"]');
  await shot(page, "01-list.png");
  const listIds = await idsWithPrefix(page, "members-edit-");
  const declinedIds = [];
  for (const id of listIds) {
    const badge = page.getByTestId(`members-status-${id}`);
    const txt = (await badge.innerText().catch(() => "")) || "";
    if (/辞退/.test(txt)) declinedIds.push(id);
  }
  const listActive = listIds.filter((id) => !declinedIds.includes(id));

  // ---- 組織図: chip ids ----
  await gotoTab(page, "組織図");
  await page.waitForSelector('[data-testid="members-orgchart"]');
  await shot(page, "02-orgchart.png");
  const orgIds = await idsWithPrefix(page, "members-orgchip-");

  // (a) 一覧(非辞退) == 組織図
  const aOk = eqSet(listActive, orgIds);
  console.log(`[a] 一覧total=${listIds.length} 辞退=${declinedIds.length} 一覧(active)=${listActive.length} 組織図chip=${orgIds.length} match=${aOk}`);
  if (!aOk) {
    console.log("  listActive:", JSON.stringify([...listActive].sort()));
    console.log("  org       :", JSON.stringify([...orgIds].sort()));
    fail("(a) 一覧(非辞退) と 組織図 の氏名(id)集合が不一致");
  }

  // ---- (c) チーム別 行数 == 組織図 計N名 ----
  await gotoTab(page, "チーム別");
  await page.waitForSelector('[data-testid^="members-teamcard-"]');
  await shot(page, "03-teams.png");
  const cards = page.locator('[data-testid^="members-teamcard-"]');
  const teamRowCount = {};
  const cc = await cards.count();
  for (let i = 0; i < cc; i++) {
    const card = cards.nth(i);
    const tid = (await card.getAttribute("data-testid")).slice("members-teamcard-".length);
    if (tid === "unassigned") continue;
    teamRowCount[tid] = await card.locator('[data-testid^="members-teamrow-"]').count();
  }

  await gotoTab(page, "組織図");
  await page.waitForSelector('[data-testid="members-orgchart"]');
  const cols = page.locator('[data-testid^="members-orgcol-"]');
  const oc = await cols.count();
  let cOk = true;
  for (let i = 0; i < oc; i++) {
    const col = cols.nth(i);
    const tid = (await col.getAttribute("data-testid")).slice("members-orgcol-".length);
    const footer = (await col.getByText(/計\d+名/).first().innerText()) || "";
    const orgTotal = Number((/計(\d+)名/.exec(footer) || [])[1]);
    if (tid in teamRowCount) {
      const ok = teamRowCount[tid] === orgTotal;
      console.log(`[c] team ${tid}: チーム別行数=${teamRowCount[tid]} 組織図計=${orgTotal} match=${ok}`);
      if (!ok) cOk = false;
    }
  }
  if (!cOk) fail("(c) チーム別 人数 と 組織図 計N名 が不一致");

  // ---- (b) 一覧で追加 → 組織図に即反映 ----
  const orgBefore = orgIds.length;
  await gotoTab(page, "一覧");
  await page.getByTestId("members-add-member").click();
  await page.waitForSelector('[data-testid="members-form-dialog"]');
  const uniq = `E2E追加太郎${Date.now() % 100000}`;
  await page.locator("#member-name").fill(uniq);
  await page.locator("#member-role").fill("オーガナイザー").catch(() => {});
  // assign to 開発チーム so it lands in a colored column
  await page.locator('#member-team-team_dev').check().catch(async () => {
    await page.getByText("開発チーム", { exact: false }).first().click().catch(() => {});
  });
  await page.getByTestId("members-form-submit").click();
  await page.waitForSelector('[data-testid="members-form-dialog"]', { state: "detached", timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(600);

  await gotoTab(page, "組織図");
  await page.waitForSelector('[data-testid="members-orgchart"]');
  const orgAfterIds = await idsWithPrefix(page, "members-orgchip-");
  const nameShown = await page.getByText(uniq).first().isVisible().catch(() => false);
  const bOk = orgAfterIds.length === orgBefore + 1 && nameShown;
  console.log(`[b] add "${uniq}" → 組織図chip ${orgBefore}→${orgAfterIds.length} 氏名表示=${nameShown} match=${bOk}`);
  await shot(page, "04-orgchart-after-add.png");
  if (!bOk) fail("(b) 一覧で追加したメンバーが 組織図 に反映されない");

  if (errors.length) console.log("browser console errors:", errors.slice(0, 5));
  console.log("E2E PASS: 3ビューが同一データソースを反映 (a,b,c すべて一致)");
  await browser.close();
}

main().catch((e) => { console.error("E2E FAIL:", e.message); process.exitCode = 1; });
