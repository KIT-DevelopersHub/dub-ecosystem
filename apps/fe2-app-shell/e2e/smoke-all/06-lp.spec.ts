// LP 管理（設定・チケット）と公開 LP。公開の切り替えは demo だけで往復させる。
import { CAN_WRITE, PUBLIC_LP_URL, enter, expect, expectNoErrorScreen, test } from "./_support.ts";

test("LP 管理: 設定 → チケット", async ({ page, shot }) => {
  await enter(page, "/lp");
  await expect(page.getByTestId("fe2-lp-config-screen")).toBeVisible();
  await expect(page.getByTestId("fe2-lp-config-ticketsEnabled")).toBeVisible();
  await expectNoErrorScreen(page);
  await shot("06-lp-config");

  await page.getByTestId("fe2-lp-tabs-tab-tickets").click();
  await expect(page.getByTestId("fe2-lp-tickets-screen")).toBeVisible();
  await expect(page.getByTestId("fe2-lp-ticket-types-table")).toBeVisible();
  await expectNoErrorScreen(page);
  await shot("06-lp-tickets");
});

test("LP 管理: 公開設定の切り替え（demo のみ・往復で元に戻す）", async ({ page, shot }) => {
  test.skip(!CAN_WRITE, "staging の公開設定は変えない");
  await enter(page, "/lp");
  // Switch は input[role=switch] に testid が付き、見た目のつまみで覆われる。
  const toggle = page.getByTestId("fe2-lp-config-ticketsEnabled");
  await expect(toggle).toBeAttached();
  const before = await toggle.isChecked();
  await toggle.dispatchEvent("click");
  await expect(toggle).toBeChecked({ checked: !before });
  await shot("06-lp-toggle");
  await toggle.dispatchEvent("click");
  await expect(toggle).toBeChecked({ checked: before });
});

test("公開 LP: トップが表示される（読み取りのみ）", async ({ page, shot }) => {
  test.skip(!PUBLIC_LP_URL, "SMOKE_PUBLIC_LP_URL が無い");
  const res = await page.goto(PUBLIC_LP_URL);
  expect(res?.status()).toBeLessThan(400);
  await expect(page.locator("body")).not.toBeEmpty();
  await expect(page.locator("h1, h2").first()).toBeVisible();
  await shot("06-public-lp");
});
