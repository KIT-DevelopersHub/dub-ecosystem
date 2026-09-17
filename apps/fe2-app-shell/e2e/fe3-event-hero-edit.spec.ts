// fe3 event hub — hero (title / dates) inline-edit regression E2E (real browser,
// DEMO transport). Before this fix, pressing 編集 on the hub navigated away to a
// separate /events/:id/settings screen, and that screen's 詳細へ戻る then landed on
// yet another screen (/events/:id, EventDetailPage) instead of back on the hub —
// so the user appeared to bounce between screens with no way back. The fix makes
// title/date editing happen in place on the hub, same pattern as the (working)
// description/detail section below it — no navigation at all.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "fe3-event-hero-edit");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

test("hub hero title/date edit is in-place — no navigation away, no lost 戻る", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The hub reads the globally-selected event (header switcher / localStorage);
  // pick evt_1 via the header switcher first so the hub isn't stuck on its
  // "イベントを選択してください" empty state.
  await page.goto("/events");
  await page.getByTestId("fe2-global-event-menu").click();
  await page.getByTestId("fe2-global-event-item-evt_1").click();
  await page.goto("/events");

  const hero = page.getByTestId("fe3-hub-hero");
  await expect(hero).toBeVisible();
  await expect(hero.getByText("北陸ITカンファレンス 2026")).toBeVisible();

  const urlBeforeEdit = page.url();
  await page.screenshot({ path: shot("01-hub-before-edit.png"), fullPage: false });

  // Click the top 編集 button — must NOT navigate to another screen.
  await page.getByTestId("fe3-hub-edit-event").click();
  await expect(page.getByTestId("fe3-hub-edit-form")).toBeVisible();
  expect(page.url()).toBe(urlBeforeEdit); // still on /events — no route change

  // The lower "イベント詳細" (description etc.) section must be unaffected/still present.
  await expect(page.getByTestId("fe3-details")).toBeVisible();

  await page.screenshot({ path: shot("02-hub-edit-form-open.png"), fullPage: false });

  // Edit title + start/end dates (keep end after start), save.
  const titleInput = page.locator("#fe3-edit-title");
  await titleInput.fill("北陸ITカンファレンス 2026（改）");
  const startsInput = page.locator("#fe3-edit-starts");
  await startsInput.fill("2026-08-06T10:00");
  const endsInput = page.locator("#fe3-edit-ends");
  await endsInput.fill("2026-08-06T18:00");

  await page.getByTestId("fe3-settings-save").click();

  // Form closes back to the read view, in place — reflects the new title/date.
  await expect(page.getByTestId("fe3-hub-edit-form")).toBeHidden();
  await expect(hero.getByText("北陸ITカンファレンス 2026（改）")).toBeVisible();
  await expect(hero).toContainText("8月6日"); // updated schedule text
  expect(page.url()).toBe(urlBeforeEdit); // never left the hub

  await page.screenshot({ path: shot("03-hub-after-save-reflected.png"), fullPage: false });

  // Re-open and cancel — also stays in place, discards the draft.
  await page.getByTestId("fe3-hub-edit-event").click();
  await expect(page.getByTestId("fe3-hub-edit-form")).toBeVisible();
  await page.getByTestId("fe3-settings-edit-cancel").click();
  await expect(page.getByTestId("fe3-hub-edit-form")).toBeHidden();
  expect(page.url()).toBe(urlBeforeEdit);

  await page.screenshot({ path: shot("04-hub-after-cancel.png"), fullPage: false });
});

test("settings-page 詳細へ戻る still returns to the page it was opened from (EventDetailPage)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Reach settings via the EventDetailPage's own 設定 button (its legitimate entry
  // point), not via the hub (the hub no longer navigates there at all).
  await page.goto("/events/evt_1");
  await expect(page.getByTestId("fe3-detail")).toBeVisible();

  await page.getByTestId("fe3-detail-settings").click();
  await expect(page.getByTestId("fe3-settings")).toBeVisible();
  expect(page.url()).toContain("/events/evt_1/settings");

  await page.getByRole("button", { name: "詳細へ戻る" }).click();
  await expect(page.getByTestId("fe3-detail")).toBeVisible();
  expect(page.url()).toContain("/events/evt_1");
  expect(page.url()).not.toContain("/settings");

  await page.screenshot({ path: shot("05-settings-back-to-detail.png"), fullPage: false });
});
