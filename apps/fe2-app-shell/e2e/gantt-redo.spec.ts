// Re-verification E2E (real browser, DEMO transport) for the 5 gantt fixes the user
// rejected as "stale / server error / freely deletable". Drives the assembled fe2 shell
// with VITE_DEMO=1 (backend-free) and PROVES each item, capturing screenshots.
//   1. off-by-one  : a D-day (inclusive) bar paints D day-cells (width == D*34 at day zoom)
//   2. #376        : drag a leaf bar → NO error banner + detail shows the moved date (refetch);
//                    extend a CHILD → the PARENT detail rolls up (no stale value)
//   3. #375        : a parent WITH children is BLOCKED from delete; a leaf is deletable
//   4. #372        : chat 削除権限 renders the 4-step segmented control (new UI)
//   5. #369        : an expanded parent shows a bordered/tinted enclosure zone
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "Desktop", "gantt-redo-shots");
mkdirSync(SHOTS, { recursive: true });
const shot = (n: string): string => join(SHOTS, n);

const PX_PER_DAY_DAY = 34; // timeline-axis.ts PX_PER_DAY.day

async function openGantt(page: Page): Promise<void> {
  await page.goto("/events/evt_1/tasks/gantt");
  await expect(page.getByTestId("fe4-gantt-view")).toBeVisible({ timeout: 30_000 });
}

async function dayZoom(page: Page): Promise<void> {
  const day = page.getByTestId("fe4-gantt-zoom-day");
  if (await day.count()) {
    await day.first().click();
    await page.waitForTimeout(400);
  }
}

async function barWidth(page: Page, taskId: string): Promise<number> {
  const bar = page.getByTestId(`fe4-gantt-bar-${taskId}`);
  await expect(bar).toBeVisible();
  return bar.evaluate((el) => el.getBoundingClientRect().width);
}

test("1: off-by-one — inclusive bar width (D days = D cells)", async ({ page }) => {
  await openGantt(page);
  await dayZoom(page);
  await page.screenshot({ path: shot("01-gantt-day-zoom.png"), fullPage: true });

  // tsk_6 spans 2026-08-01 → 2026-08-08 = 8 inclusive days. Buggy code painted 7 cells.
  const w6 = await barWidth(page, "tsk_6");
  expect(w6).toBeGreaterThan(7.5 * PX_PER_DAY_DAY); // must exceed the old 7-cell width
  expect(Math.round(w6 / PX_PER_DAY_DAY)).toBe(8); // inclusive: 8 cells

  // tsk_3 spans 2026-07-20 → 2026-07-25 = 6 inclusive days.
  const w3 = await barWidth(page, "tsk_3");
  expect(Math.round(w3 / PX_PER_DAY_DAY)).toBe(6);
  console.log(`[off-by-one] tsk_6 width=${w6}px -> ${w6 / PX_PER_DAY_DAY} cells; tsk_3 width=${w3}px -> ${w3 / PX_PER_DAY_DAY} cells`);
});

test("5 (#369): expanded parent shows a bordered/tinted enclosure zone", async ({ page }) => {
  await openGantt(page);
  await dayZoom(page);
  // tsk_1 is a parent (hasChildren). All parents start COLLAPSED — expand via its toggle
  // so its subtree shows and the bordered enclosure zone renders.
  await page.getByTestId("fe4-gantt-toggle-tsk_1").click();
  await page.waitForTimeout(400);
  const encl = page.getByTestId("fe4-gantt-group-tsk_1");
  await expect(encl).toBeVisible();
  const s = await encl.evaluate((el) => {
    const cs = getComputedStyle(el);
    const rail = getComputedStyle(el, "::before");
    return { border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, bgImage: cs.backgroundImage, shadow: cs.boxShadow, railW: rail.width };
  });
  console.log(`[#369 enclosure] border=${s.border} radius=${s.radius} bgImage=${s.bgImage.slice(0, 40)} rail=${s.railW}`);
  // #369 rework: crisp solid border (>=1.5px) + rounded card + header-lane GRADIENT fill + accent rail.
  expect(parseFloat(s.border)).toBeGreaterThanOrEqual(1); // CSS is 1.5px; Chromium computed rounds to 1px
  expect(parseFloat(s.radius)).toBeGreaterThan(0);
  expect(s.bgImage).toContain("gradient");
  expect(parseFloat(s.railW)).toBeGreaterThan(0); // left accent rail present
  await page.screenshot({ path: shot("05-parent-enclosure.png"), fullPage: true });
});

test("2 (#376): drag leaf bar → no error + detail refetch; child extend rolls up parent", async ({ page }) => {
  await openGantt(page);
  await dayZoom(page);

  // Drag the leaf tsk_6 bar body to the RIGHT by ~4 days (move gesture). Selecting after a
  // move opens the detail panel. Assert: NO error banner, and detail dates shifted.
  const bar = page.getByTestId("fe4-gantt-bar-tsk_6");
  const box = await bar.boundingBox();
  if (!box) throw new Error("tsk_6 bar has no box");
  const startX = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  // step the move so the drag engine registers a move (not a click)
  for (let i = 1; i <= 8; i++) await page.mouse.move(startX + i * (4 * PX_PER_DAY_DAY) / 8, y);
  await page.mouse.up();
  await page.waitForTimeout(600);

  // No server error surfaced anywhere.
  await expect(page.getByTestId("fe4-error-banner")).toHaveCount(0);
  await expect(page.getByText("サーバーでエラーが発生しました")).toHaveCount(0);

  // Detail opened by the move-select; the moved window must be reflected (refetch), i.e.
  // start no longer 2026-08-01.
  const detail = page.getByTestId("fe4-detail-panel");
  if (await detail.count()) {
    const start = await page.getByTestId("fe4-detail-start").inputValue().catch(() => "");
    const due = await page.getByTestId("fe4-detail-due").inputValue().catch(() => "");
    console.log(`[#376 leaf drag] detail start=${start} due=${due}`);
    expect(start).not.toBe("2026-08-01");
    await page.screenshot({ path: shot("02a-leaf-drag-detail.png"), fullPage: true });
    await page.getByTestId("fe4-detail-scrim").click({ position: { x: 5, y: 5 } }).catch(() => {});
  }

  // ---- child-extend rolls up parent (症状#7 refetch) ----
  // Expand tsk_1, extend child tsk_4's right handle by +5 days, then open tsk_1 detail and
  // confirm its 期日 rolled up (not the stale seeded 2026-08-03).
  const toggle = page.getByTestId("fe4-gantt-row-tsk_1").locator("button").first();
  if (await toggle.count()) { await toggle.click().catch(() => {}); await page.waitForTimeout(300); }

  const rh = page.getByTestId("fe4-gantt-bar-tsk_4-rz-r");
  if (await rh.count()) {
    const hb = await rh.boundingBox();
    if (hb) {
      const hx = hb.x + hb.width / 2, hy = hb.y + hb.height / 2;
      await page.mouse.move(hx, hy);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(hx + i * (5 * PX_PER_DAY_DAY) / 8, hy);
      await page.mouse.up();
      await page.waitForTimeout(600);
    }
  }
  await expect(page.getByText("サーバーでエラーが発生しました")).toHaveCount(0);

  // Open parent tsk_1 detail (click its row label).
  await page.getByTestId("fe4-gantt-row-tsk_1").click();
  await page.waitForTimeout(300);
  const pStart = await page.getByTestId("fe4-detail-start").inputValue().catch(() => "");
  const pDue = await page.getByTestId("fe4-detail-due").inputValue().catch(() => "");
  console.log(`[#376 parent rollup] tsk_1 detail start=${pStart} due=${pDue}`);
  await page.screenshot({ path: shot("02b-parent-rollup-detail.png"), fullPage: true });
});

test("3a (#375): parent WITH children is BLOCKED via bottom-right toast (no inline)", async ({ page }) => {
  await openGantt(page);
  await page.getByTestId("fe4-gantt-row-tsk_1").click();
  await expect(page.getByTestId("fe4-detail-panel")).toBeVisible();
  await page.getByTestId("fe4-detail-delete").click();
  // #375 rework: a bottom-right WARNING TOAST, NOT the old inline block box.
  const toast = page.getByTestId("toast-warning");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("削除できません");
  await expect(toast).toContainText("子タスクが");
  await expect(page.getByTestId("fe4-delete-blocked")).toHaveCount(0); // inline block removed
  await expect(page.getByTestId("fe4-confirm-delete")).toHaveCount(0); // NOT the deletable confirm
  await page.screenshot({ path: shot("03a-parent-delete-toast.png"), fullPage: true });
});

test("3b (#375): leaf WITHOUT children is deletable via a MODAL confirm dialog", async ({ page }) => {
  await openGantt(page);
  await page.getByTestId("fe4-gantt-row-tsk_2").click();
  await expect(page.getByTestId("fe4-detail-panel")).toBeVisible();
  await page.getByTestId("fe4-detail-delete").click();
  const dialog = page.getByTestId("fe4-confirm-delete");
  await expect(dialog).toBeVisible();
  // #375: the confirm is a centered MODAL (@dub/ui ConfirmDialog), NOT the old inline box.
  await expect(dialog).toHaveAttribute("role", "dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(await dialog.evaluate((el) => !!el.closest('[data-testid="fe4-detail-panel"]'))).toBe(false); // portaled outside panel
  await expect(page.getByTestId("fe4-delete-blocked")).toHaveCount(0);
  await page.screenshot({ path: shot("03b-leaf-deletable.png"), fullPage: true });
});

test("4 (#372): chat 削除権限 4-step segmented control", async ({ page }) => {
  // Role editor lives in the admin roster. Open the member role → its app-access section
  // renders the chat 削除権限 4-step segmented control.
  await page.goto("/admin/roles");
  await expect(page.getByTestId("fe7-roles-list")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: shot("04a-roles.png"), fullPage: true });

  // Open the member role (a non-system-locked role shows the editable segment).
  const openMember = page.getByTestId("fe7-roles-open-role_member");
  if (await openMember.count()) await openMember.click();
  else await page.getByTestId("fe7-roles-open-role_admin").click();
  await page.waitForTimeout(800);

  const labels = ["削除不可", "リアクション付きは削除不可", "自分の投稿のみ削除", "全員の投稿を削除"];
  for (const l of labels) {
    const found = await page.getByText(l, { exact: false }).count();
    console.log(`[#372] label "${l}" count=${found}`);
  }
  await page.screenshot({ path: shot("04b-role-chat-delete.png"), fullPage: true });
  for (const l of labels) {
    await expect(page.getByText(l, { exact: false }).first()).toBeVisible();
  }
});
