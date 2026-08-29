// Chat channel enrichment E2E (real browser, DEMO transport). Proves the chat
// sidebar renders a full Slack-style set — 全体 / チーム別 / 役割別 — where before it
// showed an empty state. Team channels mirror member-service's real 運営チーム.
// Screenshots are written to ~/DubVault/docs/chat-channels/.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "chat-channels");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

// Every channel that must appear in the sidebar, by group.
const OVERALL = ["general", "announcements", "random"];
const TEAMS = ["team-soukatsu", "team-dev", "team-ops", "team-sponsor", "team-venue", "team-pr"];
const ROLES = ["admin", "maintainers", "dev", "design", "pr-koho", "help"];
const EVENT = ["北陸itカンファレンス"];
const ALL = [...OVERALL, ...TEAMS, ...ROLES, ...EVENT];

test("chat sidebar shows 全体 / チーム別 / 役割別 channels (enriched, not empty)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/chat");

  const list = page.getByTestId("fe6-channel-list");
  await expect(list).toBeVisible();

  // The full channel set is present (name-exact match within the sidebar).
  const names = await page.getByTestId("fe6-channel-list-item").locator(".channelName, [class*='channelName']").allTextContents();
  const seen = names.map((n) => n.trim());
  for (const ch of ALL) {
    expect(seen, `channel "${ch}" must be in the sidebar (got: ${seen.join(", ")})`).toContain(ch);
  }

  await page.screenshot({ path: shot("01-chat-channels-sidebar.png"), fullPage: false });

  // Group headers: topic → "チャンネル", event → "イベント" (toggle buttons).
  await expect(list.locator("button").filter({ hasText: "チャンネル" }).first()).toBeVisible();
  await expect(list.locator("button").filter({ hasText: "イベント" }).first()).toBeVisible();

  // Opening a team channel renders its header (master-detail, no crash on empty timeline).
  await page.getByTestId("fe6-channel-list-item").filter({ hasText: "team-dev" }).first().click();
  const header = page.getByTestId("fe6-channel-header");
  await expect(header).toBeVisible();
  await expect(header).toContainText("team-dev");
  await page.screenshot({ path: shot("02-chat-team-channel-open.png"), fullPage: false });
});
