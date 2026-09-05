// Real-browser E2E for the メール名簿 ↔ 運営メンバー 紐付け feature.
// Drives the fe7 standalone harness (mock client, alice=admin) against a running vite dev
// server. Proves: 運営メンバー列表示 → 未紐付けメールの「運営メンバーと紐付け」→ 選択 → 紐付け
// → Badge反映(楽観的) → 解除。Screenshots land in ~/DubVault/docs/roster-email-link/.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE || "http://localhost:5173";
const OUT = join(homedir(), "DubVault", "docs", "roster-email-link");
mkdirSync(OUT, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(OUT, name), fullPage: true });

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ok:", msg);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text()); });

try {
  console.log("1) load メール名簿");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByTestId("fe7-users-header").waitFor();
  await page.getByTestId("fe7-users-table").waitFor();
  // 運営メンバー column header present
  assert(await page.getByRole("columnheader", { name: "運営メンバー" }).count() > 0, "運営メンバー列が表示される");
  // Carol (user_carol) is unlinked → link button present
  const linkBtn = page.getByTestId("fe7-users-member-link-user_carol");
  await linkBtn.waitFor();
  assert(await linkBtn.isVisible(), "未紐付けメール(Carol)に「運営メンバーと紐付け」ボタン");
  // Bob (user_bob) is pre-linked to 佐藤 太郎 → badge shown
  assert((await page.getByTestId("fe7-users-member-user_bob").innerText()).includes("佐藤 太郎"), "紐付け済みメール(Bob)は運営メンバー名バッジを表示");
  await shot(page, "01-mail-roster-member-column.png");

  console.log("2) open 紐付けダイアログ (Carol)");
  await linkBtn.click();
  await page.getByTestId("fe7-member-link-dialog").waitFor();
  await page.getByTestId("fe7-member-link-option-member_hanako").waitFor();
  // 佐藤 太郎 (member_bob) already linked to Bob → disabled in the picker (1:1 guard)
  assert(await page.getByTestId("fe7-member-link-option-member_bob").isDisabled(), "既に別アカウントに紐付いたメンバーは選択不可");
  await shot(page, "02-link-dialog-open.png");

  console.log("3) select 山田 花子 → 紐付ける (楽観的反映)");
  await page.getByTestId("fe7-member-link-option-member_hanako").click();
  await page.getByTestId("fe7-member-link-confirm").click();
  // dialog closes, Carol row now shows the member badge
  await page.getByTestId("fe7-member-link-dialog").waitFor({ state: "hidden" });
  const carolCell = page.getByTestId("fe7-users-member-user_carol");
  await carolCell.getByText("山田 花子").waitFor();
  assert((await carolCell.innerText()).includes("山田 花子"), "紐付け後、Carol行に運営メンバー(山田 花子)が反映");
  await shot(page, "03-linked-optimistic.png");

  console.log("4) 解除 (unlink)");
  await page.getByTestId("fe7-users-member-unlink-user_carol").click();
  await page.getByTestId("fe7-users-member-link-user_carol").waitFor();
  assert(await page.getByTestId("fe7-users-member-link-user_carol").isVisible(), "解除後、再び「運営メンバーと紐付け」ボタンに戻る");
  await shot(page, "04-unlinked.png");

  console.log("\nE2E PASSED ✅  screenshots ->", OUT);
} catch (e) {
  await shot(page, "99-failure.png").catch(() => {});
  console.error("\nE2E FAILED ❌", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
