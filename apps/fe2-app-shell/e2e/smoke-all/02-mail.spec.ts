// メール: 受信一覧 → スレッド → 作成（送信は demo のみ。staging は本物の外部送信になるため）。
import { CAN_WRITE, enter, expect, expectNoErrorScreen, test } from "./_support.ts";

test("受信一覧 → スレッドを開く → 戻る", async ({ page, shot }) => {
  await enter(page, "/mail/inbox");
  await expect(page.getByTestId("fe2-mail-inbox")).toBeVisible();
  const rows = page.getByTestId("fe2-mail-inbox-item");
  await expect(rows.first()).toBeVisible();
  await expectNoErrorScreen(page);
  await shot("02-mail-inbox");

  await rows.first().click();
  await expect(page.getByTestId("fe2-mail-thread")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-thread-message").first()).toBeVisible();
  await shot("02-mail-thread");
  await page.getByTestId("fe2-mail-thread-back").click();
  await expect(page.getByTestId("fe2-mail-inbox")).toBeVisible();
});

test("作成画面 → 送信 → 送信済みに出る", async ({ page, shot }) => {
  await enter(page, "/mail/inbox");
  await page.getByTestId("fe2-mail-inbox-compose").click();
  await expect(page.getByTestId("fe2-mail-compose")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-compose-to")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-compose-subject")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-compose-body")).toBeVisible();
  await shot("02-mail-compose");

  test.skip(!CAN_WRITE, "staging の送信は本物の外部送信になるため demo だけで送る");
  const subject = `総点検 送信テスト ${Date.now()}`;
  await page.getByTestId("fe2-mail-compose-to").fill("teammate@example.com");
  await page.getByTestId("fe2-mail-compose-subject").fill(subject);
  await page.getByTestId("fe2-mail-compose-body").fill("総点検の送信本文です。");
  await page.getByTestId("fe2-mail-compose-send").click();
  // #929: 送信後に離脱の確認が出て送信済みへ移らない（直るまでここで落ちる）。
  await expect(page.getByTestId("fe2-mail-sent")).toBeVisible();
  await expect(page.getByText(subject)).toBeVisible();
  await shot("02-mail-sent");
});
