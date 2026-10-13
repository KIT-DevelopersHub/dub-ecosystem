// 別のロール宛てのメールも閲覧 (cross-role mail visibility) — real browser, DEMO transport.
//   1. ロール管理: the 統括 role's メール 詳細設定 lists the other roles, with maintainer +
//      member ON, and the table row points at it (別ロール 2). Reached by the ?role=&app=
//      deep link.
//   2. メール (/mail): the 統括 account reads maintainer (佐藤) + member (鈴木) inbound mail
//      under 自分宛て以外; 佐藤 does NOT see the 統括 inbox (one-way).
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "..", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

const ns = "fe7-role-role_lead";
const LEAD_SUBJECT = "年度末の活動報告書の提出について";
const BOB_SUBJECT = "委員会の議事録共有";
const SPONSOR_SUBJECT = "協賛プランのお見積り依頼";

async function asAccount(page: Page, accountId: string, path: string): Promise<void> {
  await page.goto(`${path}${path.includes("?") ? "&" : "?"}demo_account=${accountId}`);
}

test("ロール管理: 統括 role's メール 詳細設定 shows the cross-role picks", async ({ page }) => {
  await asAccount(page, "usr_demo", "/admin/roles?role=role_lead&app=mail");
  const dialog = page.getByTestId(`${ns}-app-dialog`);
  await expect(dialog).toBeVisible();
  const section = dialog.getByTestId(`${ns}-mail-cross-role`);
  await expect(section).toBeVisible();
  await expect(dialog.getByText("別のロール宛てのメールも閲覧")).toBeVisible();
  await expect(section.getByTestId(`${ns}-mail-cross-role-toggle-role_maintainer`)).toBeChecked();
  await expect(section.getByTestId(`${ns}-mail-cross-role-toggle-role_member`)).toBeChecked();
  await expect(section.getByTestId(`${ns}-mail-cross-role-toggle-role_admin`)).not.toBeChecked();
  await expect(section.getByTestId(`${ns}-mail-cross-role-row-role_lead`)).toHaveCount(0);
  await expect(section.getByTestId(`${ns}-mail-cross-role-count`)).toHaveText("2 / 3 ロール");
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot("xrole-01-dialog.png"), fullPage: true });

  await dialog.getByTestId(`${ns}-app-dialog-close`).click();
  await expect(page.getByTestId(`${ns}-app-detail-extra-mail`)).toHaveText("別ロール 2");
  await page.getByTestId(`${ns}-app-detail-extra-mail`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot("xrole-02-table-badge.png"), fullPage: true });
});

test("メール: 統括 reads other roles' inbound mail under 自分宛て以外; one-way", async ({ page }) => {
  await asAccount(page, "usr_lead", "/mail");
  await expect(page.getByTestId("fe2-mail-sidebar")).toBeVisible();
  await page.getByTestId("fe2-mail-folder-others").click();
  const rows = page.getByTestId("fe2-mail-inbox-item");
  await expect(rows.filter({ hasText: BOB_SUBJECT })).toHaveCount(1);
  await expect(rows.filter({ hasText: SPONSOR_SUBJECT })).toHaveCount(1);
  await expect(rows.filter({ hasText: LEAD_SUBJECT })).toHaveCount(0);
  await expect(page.getByTestId("fe2-mail-shared-chip").first()).toBeVisible();
  await page.waitForTimeout(500); // let the folder transition settle before the screenshot
  await page.screenshot({ path: shot("xrole-03-lead-others.png"), fullPage: true });

  await page.getByTestId("fe2-mail-folder-mine").click();
  await expect(page.getByTestId("fe2-mail-inbox-item").filter({ hasText: LEAD_SUBJECT })).toHaveCount(1);

  // 佐藤 (maintainer) sees only their own mail: no 統括 mail, no 自分宛て以外 view at all.
  await asAccount(page, "usr_bob", "/mail");
  await expect(page.getByTestId("fe2-mail-sidebar")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-inbox-item").filter({ hasText: BOB_SUBJECT })).toHaveCount(1);
  await expect(page.getByTestId("fe2-mail-inbox-item").filter({ hasText: LEAD_SUBJECT })).toHaveCount(0);
  await expect(page.getByTestId("fe2-mail-folder-others")).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot("xrole-04-bob-inbox.png"), fullPage: true });
});
