// 作成できるチャンネルの 3 択 — real browser, DEMO transport.
//   1. ロール管理: チャットの詳細設定で 3 択を選んで保存すると、開き直しても保持される
//      （「作成できない」が保存で巻き戻らない）。
//   2. チャット: 3 択それぞれの権限で、作成導線がそのとおりに出る。
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "..", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

// システムロールはデモのモックが保存を拒否するので、カスタムロールで保存まで通す。
const ns = "fe7-role-role_lead";

async function openChat(page: Page, accountId: string): Promise<void> {
  await page.goto(`/chat?demo_account=${accountId}`);
  await expect(page.getByTestId("fe6-channel-list")).toBeVisible();
}

test("ロール管理: 3 択を選んで保存すると保持される", async ({ page }) => {
  await page.goto(`/admin/roles?role=role_lead&app=chat&demo_account=usr_demo`);
  const dialog = page.getByTestId(`${ns}-app-dialog`);
  await expect(dialog).toBeVisible();
  const section = dialog.getByTestId(`${ns}-chat-create-scope`);
  await expect(section).toBeVisible();
  await expect(dialog.getByTestId(`${ns}-app-dialog-toggle-chat:create`)).toHaveCount(0);

  // 編集でないロールは理由を出して触らせない。
  await expect(section.getByTestId(`${ns}-chat-create-scope-locked`)).toBeVisible();
  await dialog.getByTestId(`${ns}-app-dialog-level-edit`).click();

  await section.getByTestId(`${ns}-chat-create-scope-none`).click();
  await expect(section.getByText("チャンネルも DM も新しく作成できません")).toBeVisible();
  await dialog.getByTestId(`${ns}-app-dialog-close`).click();
  await page.getByTestId(`${ns}-save`).click();
  await page.getByRole("dialog", { name: "権限束を保存" }).getByRole("button", { name: "確認" }).click();
  await expect(page.getByText("ロールを保存しました")).toBeVisible();
  await expect(page.getByText("保存に失敗しました")).toHaveCount(0);

  await page.getByTestId(`${ns}-app-detail-chat`).click();
  await expect(page.getByTestId(`${ns}-chat-create-scope-none`)).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(400); // モーダルのアニメーション完了を待って撮る
  await page.screenshot({ path: shot("chat-create-scope-01-saved-none.png") });

  // 開き直した 3 択をパブリックのみに変えて、こちらも保存できる。
  await page.getByTestId(`${ns}-chat-create-scope-public`).click();
  await page.getByTestId(`${ns}-app-dialog-close`).click();
  await page.getByTestId(`${ns}-save`).click();
  await page.getByRole("dialog", { name: "権限束を保存" }).getByRole("button", { name: "確認" }).click();
  await expect(page.getByText("ロールを保存しました").first()).toBeVisible();
  await expect(page.getByText("保存に失敗しました")).toHaveCount(0);
});

test("パブリックとプライベート: Private を作成できる", async ({ page }) => {
  await openChat(page, "usr_bob");
  await page.getByTestId("fe6-channel-create").click();
  await expect(page.getByTestId("fe6-create-private")).toBeEnabled();
  await page.getByTestId("fe6-create-name").fill("private-e2e");
  await page.getByTestId("fe6-create-private").check();
  await page.getByTestId("fe6-create-submit").click();
  await expect(page.getByTestId("fe6-create-channel-modal")).toHaveCount(0);
  await expect(page.getByTestId("fe6-channel-list").getByText("private-e2e")).toBeVisible();
});

test("パブリックのみ: Private は選べず、Public は作成できる", async ({ page }) => {
  await openChat(page, "usr_chat_public");
  await page.getByTestId("fe6-channel-create").click();
  await expect(page.getByTestId("fe6-create-private")).toBeDisabled();
  await expect(page.getByTestId("fe6-create-private-denied")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot("chat-create-scope-02-public-only.png") });
  await page.getByTestId("fe6-create-name").fill("public-e2e");
  await page.getByTestId("fe6-create-submit").click();
  await expect(page.getByTestId("fe6-channel-list").getByText("public-e2e")).toBeVisible();
});

test("作成できない: チャンネルも DM も作成導線が出ない", async ({ page }) => {
  await openChat(page, "usr_chat_none");
  await expect(page.getByTestId("fe6-channel-create")).toHaveCount(0);
  await expect(page.getByTestId("fe6-dm-new")).toHaveCount(0);
  await page.screenshot({ path: shot("chat-create-scope-03-none.png") });
});
