// ログイン・プロフィール・ログアウト。
import { CAN_WRITE, enter, expect, expectNoErrorScreen, test } from "./_support.ts";

test("ログイン → ホーム → プロフィール → ログアウト", async ({ page, shot }) => {
  await enter(page, "/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();
  await expect(page.getByTestId("fe2-home-kpis")).toBeVisible();
  await expectNoErrorScreen(page);
  await shot("01-home");

  await page.getByTestId("fe2-settings-menu-trigger").click();
  await page.getByTestId("fe2-account-settings-open").click();
  const dialog = page.getByTestId("fe2-account-settings");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("fe2-account-name")).toBeVisible();
  await expect(page.getByTestId("fe2-account-password-open")).toBeVisible();
  await expect(page.getByTestId("fe2-account-passkeys-open")).toBeVisible();
  await shot("01-profile");
  await page.getByTestId("fe2-account-settings-cancel").click();
  await expect(dialog).toBeHidden();

  // demo は自動ログインなので、ログアウトの確認は実環境（staging）だけで行う。
  test.skip(CAN_WRITE, "demo は自動ログインのためログアウトは staging で確認");
  await page.getByTestId("fe2-settings-menu-trigger").click();
  await page.getByTestId("fe2-logout").click();
  await expect(page.getByTestId("fe2-login-submit")).toBeVisible();
  await shot("01-logout");
  // ログアウト後に保護された画面を開いてもログイン画面へ戻される。
  await page.goto("/mail/inbox");
  await expect(page.getByTestId("fe2-login-submit")).toBeVisible();
});
