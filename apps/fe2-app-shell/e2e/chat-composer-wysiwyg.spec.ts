// Composer draft is WYSIWYG (Slack parity): formatting shows as formatting while
// typing — never as * / _ / ` markers — and survives a channel switch and a reload.
// Real browser, DEMO transport. Screenshots: E2E_SHOTS (default ~/DubVault/docs/chat-composer-wysiwyg).
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = process.env.E2E_SHOTS ?? join(homedir(), "DubVault", "docs", "chat-composer-wysiwyg");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

test("下書きの書式はその場で反映され、記号のまま表示されない", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/chat");
  const channels = page.getByTestId("fe6-channel-list-item");
  await channels.filter({ hasText: "general" }).first().click();
  await expect(page.getByTestId("fe6-channel-timeline")).toBeVisible();

  const input = page.getByTestId("fe6-composer-input");
  await input.click();

  // Cmd/Ctrl+B で太字 → 太字のまま見える。
  await page.keyboard.type("これは ");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("太字");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type(" です。");
  // 記法を直接打っても、閉じた瞬間に書式へ変わる。
  await page.keyboard.type("そして *強調* と `code` と _斜体_");
  // 改行して箇条書き。
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("- 項目1");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("項目2");

  const assertFormatted = async () => {
    await expect(input.locator("b").first()).toHaveText("太字");
    await expect(input.locator("b").nth(1)).toHaveText("強調");
    await expect(input.locator("code")).toHaveText("code");
    await expect(input.locator("i")).toHaveText("斜体");
    await expect(input.locator("[data-block='bullet']")).toHaveCount(2);
    const text = (await input.textContent()) ?? "";
    expect(text).not.toMatch(/[*_`]/);
    expect(text).not.toContain("- 項目");
  };
  await assertFormatted();
  await page.screenshot({ path: shot("01-draft-formatted.png") });

  // 別チャンネルへ行って戻っても、書式付きのまま残る。
  await channels.filter({ hasNotText: "general" }).first().click();
  await expect(input).toHaveAttribute("data-empty", "true");
  await channels.filter({ hasText: "general" }).first().click();
  await assertFormatted();

  // 再読み込みしても同じ。
  await page.reload();
  await page.getByTestId("fe6-channel-list-item").filter({ hasText: "general" }).first().click();
  await assertFormatted();
  await page.screenshot({ path: shot("02-draft-after-reload.png") });

  // 送信すると、下書きと同じ見た目で投稿される。
  // Enter で送信 (送信ボタンは右下のフィードバック FAB と重なっていてクリックできない: main 既存)。
  await input.press("Enter");
  await expect(input).toHaveAttribute("data-empty", "true");
  const posted = page.getByTestId("fe6-channel-timeline").getByText("太字", { exact: true }).last();
  await expect(posted).toBeVisible();
  await expect(posted).toHaveJSProperty("tagName", "STRONG");
  await page.screenshot({ path: shot("03-sent.png") });
});
