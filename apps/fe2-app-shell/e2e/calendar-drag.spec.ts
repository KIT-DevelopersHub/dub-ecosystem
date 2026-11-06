// Real-browser drag & drop of existing calendar items (demo transport, like the other specs).
import { expect, test, type Locator, type Page } from "@playwright/test";

const HOUR_PX = 48;

function dayKey(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function openWeek(page: Page) {
  await page.goto("/calendar");
  await expect(page.getByTestId("calendar-timegrid")).toBeVisible();
  await page.getByTestId("calendar-view-menu").click();
  await page.getByTestId("calendar-view-week").click();
}

/** Makes a 予定 by dragging a slot, the way a user does. */
async function createEvent(page: Page, title: string, dayOffset: number, startHour: number) {
  const col = page.getByTestId(`calendar-col-${dayKey(dayOffset)}`);
  await col.evaluate((el, y) => el.parentElement!.parentElement!.scrollTo({ top: y }), (startHour - 1) * HOUR_PX);
  const box = (await col.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + startHour * HOUR_PX + 4);
  await page.getByRole("textbox", { name: /タイトル/ }).first().fill(title);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByTestId("toast-success").filter({ hasText: "予定を保存しました" })).toBeVisible();
  return page.locator('[data-testid^="calendar-item-"]', { hasText: title }).first();
}

async function center(l: Locator) {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + 8 };
}

async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, release = true) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  if (release) await page.mouse.up();
}

test("moves a 予定 to another day and time, and 元に戻す restores it", async ({ page }) => {
  await openWeek(page);
  const item = await createEvent(page, "ドラッグ確認", 2, 10);
  await expect(item).toContainText("10:00～11:00");

  const from = await center(item);
  const target = (await page.getByTestId(`calendar-col-${dayKey(3)}`).boundingBox())!;
  await dragTo(page, from, { x: target.x + target.width / 2, y: from.y + HOUR_PX });

  await expect(page.getByTestId("toast-success").filter({ hasText: "予定を移動しました" })).toBeVisible();
  const moved = page.getByTestId(`calendar-col-${dayKey(3)}`).locator('[data-testid^="calendar-item-"]', { hasText: "ドラッグ確認" });
  await expect(moved).toContainText("11:00～12:00");
  // A drag is not a click: no detail panel opened.
  await expect(page.getByRole("button", { name: "編集" })).toHaveCount(0);

  await page.getByRole("button", { name: "元に戻す" }).click();
  const back = page.getByTestId(`calendar-col-${dayKey(2)}`).locator('[data-testid^="calendar-item-"]', { hasText: "ドラッグ確認" });
  await expect(back).toContainText("10:00～11:00");
});

test("resizes from the bottom edge, and Esc cancels a drag", async ({ page }) => {
  await openWeek(page);
  const item = await createEvent(page, "長さ確認", 2, 13);
  const handle = item.locator('[data-testid^="calendar-resize-"]');
  const b = (await handle.boundingBox())!;
  await dragTo(page, { x: b.x + b.width / 2, y: b.y + 3 }, { x: b.x + b.width / 2, y: b.y + 3 + HOUR_PX / 2 });
  await expect(item).toContainText("13:00～14:30");
  // A row with a write in flight waits for its new version before it can be picked up again.
  await expect(page.getByTestId("toast-success").filter({ hasText: "予定の時間を変更しました" })).toBeVisible();

  const from = await center(item);
  await dragTo(page, from, { x: from.x, y: from.y + HOUR_PX * 2 }, false);
  await expect(item).toContainText("15:00～16:30");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(item).toContainText("13:00～14:30");
});

test("a click still opens the detail; a 予定 moves between 時間 and 終日", async ({ page }) => {
  await openWeek(page);
  const item = await createEvent(page, "終日確認", 2, 16);
  await item.click();
  await expect(page.getByRole("button", { name: /編集/ }).first()).toBeVisible();
  await page.keyboard.press("Escape");

  const from = await center(item);
  const cell = (await page.getByTestId("calendar-allday").boundingBox())!;
  const col = (await page.getByTestId(`calendar-col-${dayKey(4)}`).boundingBox())!;
  await dragTo(page, from, { x: col.x + col.width / 2, y: cell.y + 8 });
  await expect(page.getByTestId("calendar-allday").locator('[data-testid^="calendar-item-"]', { hasText: "終日確認" })).toBeVisible();
});

test("月: dragging keeps the time and changes the day", async ({ page }) => {
  await openWeek(page);
  await createEvent(page, "月確認", 2, 9);
  await page.getByTestId("calendar-view-menu").click();
  await page.getByTestId("calendar-view-month").click();
  const item = page.locator('[data-testid^="calendar-item-"]', { hasText: "月確認" });
  const from = await center(item);
  const key = dayKey(3);
  const target = (await page.getByTestId(`calendar-day-${key}`).boundingBox())!;
  await dragTo(page, from, { x: target.x + target.width / 2, y: target.y + target.height - 10 });
  await page.getByTestId("calendar-view-menu").click();
  await page.getByTestId("calendar-view-week").click();
  await expect(page.getByTestId(`calendar-col-${key}`).locator('[data-testid^="calendar-item-"]', { hasText: "月確認" })).toContainText("9:00～10:00");
});

test.describe("ミーティング", () => {
  const meeting = (id: string, title: string, recurrence: string, hour: number) => {
    const [y, m, d] = dayKey(2).split("-").map(Number) as [number, number, number];
    return {
      id,
      title,
      description: null,
      targetId: "all",
      targetName: "全体",
      startsAt: new Date(Date.UTC(y, m - 1, d, hour - 9)).toISOString(),
      durationMinutes: 60,
      recurrence,
      until: null,
      meetUrl: "https://meet.google.com/abc-defg-hij",
      htmlLink: "https://calendar.google.com/calendar/",
      attendeeCount: 12,
      trackAttendance: false,
      createdBy: "usr_demo_admin",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
    };
  };

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((items) => {
      sessionStorage.setItem("dub-demo:calendar-meetings", JSON.stringify(items));
    }, [meeting("mtg_once", "単発の打合せ", "none", 11), meeting("mtg_rec", "毎週の定例", "weekly", 15)]);
  });

  test("a one-off asks before moving; cancelling puts it back", async ({ page }) => {
    await openWeek(page);
    const item = page.locator('[data-testid^="calendar-item-meet:mtg_once"]');
    await item.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const from = await center(item);

    await dragTo(page, from, { x: from.x, y: from.y + HOUR_PX });
    const dialog = page.getByTestId("calendar-meeting-move-confirm");
    await expect(dialog).toContainText("12:00〜13:00");
    await expect(item).toContainText("12:00～13:00");
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(item).toContainText("11:00～12:00");

    await dragTo(page, from, { x: from.x, y: from.y + HOUR_PX });
    await dialog.getByRole("button", { name: "移動する" }).click();
    await expect(page.getByTestId("toast-success").filter({ hasText: "ミーティングを移動しました" })).toBeVisible();
    await expect(item).toContainText("12:00～13:00");
  });

  test("a 定例 stays put and a click still opens it", async ({ page }) => {
    await openWeek(page);
    const item = page.locator('[data-testid^="calendar-item-meet:mtg_rec"]');
    await item.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const from = await center(item);
    await dragTo(page, from, { x: from.x, y: from.y + HOUR_PX }, false);
    await expect(item).toHaveClass(/dragDenied/);
    const warning = page.getByTestId("toast-warning").filter({ hasText: "権限不足で実行できません" });
    await expect(warning).toHaveCount(1);
    await page.mouse.up();
    await expect(page.getByTestId("calendar-meeting-move-confirm")).toHaveCount(0);
    await expect(item).toContainText("15:00～16:00");
    // The refused drag opened nothing, and repeating it does not pile up toasts.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await dragTo(page, from, { x: from.x, y: from.y + HOUR_PX });
    await expect(warning).toHaveCount(1);

    await expect(item).not.toHaveClass(/dragDenied/);
    await item.click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
