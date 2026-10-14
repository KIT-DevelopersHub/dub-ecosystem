// チーム単位メンション E2E (real browser, DEMO transport). Proves the new @チーム
// path end to end: the @-menu offers 運営チーム (統括チーム / 法人チーム) next to people,
// picking one inserts the team token, the posted message renders as a team chip, and a
// mention of MY team highlights the row exactly like a direct @me.
// Screenshots are written to ~/DubVault/docs/chat-team-mention/.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "chat-team-mention");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

test("@ でチームを選ぶと、そのチーム宛メンションとして投稿・表示される", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/chat");

  // #general opens with a seeded post that mentions 統括チーム (自分の所属) と 法人チーム.
  await page.getByTestId("fe6-channel-list-item").filter({ hasText: "general" }).first().click();
  const timeline = page.getByTestId("fe6-channel-timeline");
  await expect(timeline).toBeVisible();

  const chips = page.getByTestId("fe6-team-mention");
  await expect(chips.filter({ hasText: "統括チーム" })).toHaveCount(1);
  await expect(chips.filter({ hasText: "法人チーム" })).toHaveCount(1);
  // 自分の所属チーム宛なので、行が「自分宛メンション」として強調される。
  const mentionedRow = page.locator("[class*='mentionsMe']").filter({ hasText: "統括チーム" });
  await expect(mentionedRow.first()).toBeVisible();
  await page.screenshot({ path: shot("01-team-mention-rendered.png"), fullPage: false });

  // @ + チーム名 で候補が出る (人と同じメニュー・チームが先頭)。
  const input = page.getByTestId("fe6-composer-input");
  await input.click();
  await input.type("@法人");
  const menu = page.getByTestId("fe6-composer-mention-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("法人チーム");
  await expect(menu).toContainText("チーム全員に通知");
  await page.screenshot({ path: shot("02-team-mention-menu.png"), fullPage: false });

  // 選ぶ → チームメンションが入る(本文にはトークン、画面にはチップ)。
  await menu.getByRole("button", { name: /法人チーム/ }).first().click();
  // 入力欄は書式付き表示: トークンではなくチーム名のチップが入る。
  await expect(input.locator("[data-mention='team']")).toHaveText("@法人チーム");
  await expect(input).not.toContainText("<!team:");
  await input.type("契約書のレビューお願いします");
  // 送信ボタンは右下のフィードバック FAB と重なるので Enter で送る。
  await input.press("Enter");

  // 送信後: 生のトークンではなくチーム名のチップで表示される。
  await expect(chips.filter({ hasText: "法人チーム" })).toHaveCount(2);
  await expect(timeline).not.toContainText("<!team:");
  await page.screenshot({ path: shot("03-team-mention-posted.png"), fullPage: false });
});
