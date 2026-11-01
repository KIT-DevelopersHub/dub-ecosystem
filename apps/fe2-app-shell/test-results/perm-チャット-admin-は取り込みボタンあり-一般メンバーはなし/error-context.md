# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: perm.spec.ts >> チャット: admin は取り込みボタンあり / 一般メンバーはなし
- Location: ../../../../../../../private/tmp/slkperm/perm.spec.ts:18:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('[data-testid^=fe6-]').first()
Expected: visible
Timeout: 20000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 20000ms
  - waiting for locator('[data-testid^=fe6-]').first()

```

```yaml
- banner:
  - heading "DevHub hanako@developershub.jp" [level=1]:
    - link "DevHub":
      - /url: /
    - text: hanako@developershub.jp
  - button "イベントを選択"
  - button "アプリ一覧"
  - button "Notifications, 29 unread"
  - button "設定"
- main:
  - main:
    - text: "403"
    - heading "この機能の権限がありません" [level=1]
    - paragraph: このページを開く権限が付与されていません。利用するには管理者にロール／権限の付与を依頼してください。
    - link "ホームへ戻る":
      - /url: /
      - button "ホームへ戻る"
  - button "フィードバックを送る":
    - img "フィードバック"
- region "通知"
- note: デモモード — 表示中のデータはすべてサンプルです（バックエンド未接続・メール等は実際には送信されません）
```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test";
  2  | const KEY = "chat:slack_import";
  3  | const SHOT = (n: string) => `/tmp/slkperm/${n}.png`;
  4  | 
  5  | for (const [role, on] of [["role_admin", true], ["role_maintainer", false], ["role_member", false]] as const) {
  6  |   test(`ロール管理 ${role}: チャット 詳細設定 の Slack から取り込み = ${on ? "ON" : "OFF"}`, async ({ page }) => {
  7  |     await page.goto(`/admin/roles?role=${role}&app=chat&demo_account=usr_demo`);
  8  |     const ns = `fe7-role-${role}`;
  9  |     const dialog = page.getByTestId(`${ns}-app-dialog`);
  10 |     await expect(dialog).toBeVisible();
  11 |     await expect(dialog.getByText("Slack から取り込み")).toBeVisible();
  12 |     const toggle = dialog.getByTestId(`${ns}-app-dialog-toggle-${KEY}`);
  13 |     if (on) await expect(toggle).toBeChecked(); else await expect(toggle).not.toBeChecked();
  14 |     await page.screenshot({ path: SHOT(`roles-${role}`) });
  15 |   });
  16 | }
  17 | 
  18 | test("チャット: admin は取り込みボタンあり / 一般メンバーはなし", async ({ page }) => {
  19 |   await page.goto(`/chat?demo_account=usr_demo`);
  20 |   await expect(page.getByTestId("fe6-slack-import-open")).toBeVisible({ timeout: 20000 });
  21 |   await page.screenshot({ path: SHOT("chat-admin") });
  22 |   await page.goto(`/chat?demo_account=usr_member`);
> 23 |   await expect(page.locator("[data-testid^=fe6-]").first()).toBeVisible({ timeout: 20000 });
     |                                                             ^ Error: expect(locator).toBeVisible() failed
  24 |   await page.waitForTimeout(1500);
  25 |   await expect(page.getByTestId("fe6-slack-import-open")).toHaveCount(0);
  26 |   await page.screenshot({ path: SHOT("chat-member") });
  27 | });
  28 | 
```