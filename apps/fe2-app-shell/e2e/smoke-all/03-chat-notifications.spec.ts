// チャット・通知。
import { CAN_WRITE, enter, expect, expectNoErrorScreen, test } from "./_support.ts";

test("チャット: チャンネル一覧とタイムライン（demo では投稿も）", async ({ page, shot }) => {
  await enter(page, "/chat");
  await expect(page.getByTestId("fe6-chat-app")).toBeVisible();
  await expect(page.getByTestId("fe6-channel-timeline")).toBeVisible();
  await expect(page.getByTestId("fe6-timeline-message").first()).toBeVisible();
  // 390px ではチャンネル一覧が畳まれている。
  const openList = page.getByRole("button", { name: "チャネル一覧を開く" });
  if (await openList.isVisible()) {
    await shot("03-chat-timeline");
    await openList.click();
  }
  await expect(page.getByTestId("fe6-channel-list-item").first()).toBeVisible();
  await expectNoErrorScreen(page);
  await shot("03-chat");

  test.skip(!CAN_WRITE, "staging では投稿しない");
  if (await openList.isVisible()) {
    await page.getByTestId("fe6-channel-list-item").first().click();
  }
  const text = `総点検 ${Date.now()}`;
  await page.getByTestId("fe6-composer-input").click();
  await page.keyboard.type(text);
  await page.getByTestId("fe6-composer-send").click();
  await expect(page.getByTestId("fe6-timeline-body").filter({ hasText: text })).toBeVisible();
  await shot("03-chat-posted");
});

test("通知: ベル → 一覧 → 通知画面とタブ", async ({ page, shot }) => {
  await enter(page, "/");
  await page.getByTestId("fe5-bell-button").click();
  await expect(page.getByTestId("fe5-notif-dialog")).toBeVisible();
  await shot("03-bell");
  await page.getByTestId("fe5-notif-dialog-seeall").click();
  await expect(page.getByTestId("fe5-inbox-page")).toBeVisible();
  await expect(page.getByTestId("fe5-inbox-catfilter-tab-all")).toBeVisible();
  // #857: 英語表記が残っていないこと。
  await expect(page.getByText(/Notifications|Mark all as read|Unread only/)).toHaveCount(0);
  await page.getByTestId("fe5-inbox-catfilter-tab-mail").click();
  await expectNoErrorScreen(page);
  await shot("03-notifications");
});
