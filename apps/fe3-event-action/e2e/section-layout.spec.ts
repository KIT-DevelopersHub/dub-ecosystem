// Shared event section layout (D&D order/visibility) — real browser, DEMO-style mock
// transport (createMockEventApi + localStorage), same treatment as fe2-app-shell's
// home-widget-edit.spec.ts. Proves what a jsdom unit test cannot: pointer drag
// actually reorders the detail sections, and the new order + a hide toggle survive a
// reload — this mock's localStorage stands in for the real event-service's shared,
// version-locked event_event_section_layout row (exercised for real in staging).
// Kept short and focused — two flows, no polling loops.
import { test, expect, type Page } from "@playwright/test";

async function selectFirstEvent(page: Page): Promise<void> {
  const picker = page.getByTestId("fe3-header-event-picker");
  await expect(picker).toBeVisible();
  const firstValue = await picker.locator("option").nth(1).getAttribute("value");
  if (!firstValue) throw new Error("no event seeded by the mock");
  await picker.selectOption(firstValue);
  await expect(page.getByTestId("fe3-details")).toBeVisible();
}

/** Ordered section ids currently in the "開催情報" (venueInfo) group — normalized so
 *  the SAME ids compare in and out of edit mode, mirroring fe2's kpiOrder() helper:
 *  outside editing each section's testid sits on its own chrome; while editing,
 *  SortableList wraps each row in `fe3-section-edit-<id>`. */
async function venueGroupOrder(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() => {
    const group = document.querySelector('[data-testid="fe3-section-group-venueInfo"]');
    if (!group) return [];
    return Array.from(group.children).map((child) => {
      // SortableList wraps each row in its own (untestid'd) chrome div; our
      // fe3-section-edit-<id> testid sits one level down, on its first child.
      const testId = child.getAttribute("data-testid") ?? child.firstElementChild?.getAttribute("data-testid") ?? null;
      if (testId?.startsWith("fe3-section-edit-")) return testId.slice("fe3-section-edit-".length);
      return null;
    });
  });
}

test("並べ替え編集: pointer drag reorders a section group, hide persists across reload", async ({ page }) => {
  // Belt-and-suspenders on top of the project's `reducedMotion` context option: the
  // jiggle CSS keys off prefers-reduced-motion, and Playwright's actionability check
  // ("element is stable") never resolves against a continuous CSS rotation.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await selectFirstEvent(page);

  // ── enter 並べ替え (layout) edit mode ──────────────────────────────────────
  await page.getByTestId("fe3-layout-edit-toggle").click();
  await expect(page.getByTestId("fe3-details")).toHaveAttribute("data-layout-editing", "true");
  // The content 編集 (full-form) button is hidden while layout-editing (mutually
  // exclusive edit modes — see EventDetailsPanel).
  await expect(page.getByTestId("fe3-details-edit")).toHaveCount(0);

  const beforeHandle = page.getByTestId("fe3-section-handle-venue");
  await expect(beforeHandle).toBeVisible();
  const before = await venueGroupOrder(page);
  expect(before[0]).toBe("venue"); // default catalog order: 会場 first

  // ── pointer drag: drag "会場" onto "アクセス" within the 開催情報 group ─────
  const fromBox = await beforeHandle.boundingBox();
  const toBox = await page.getByTestId("fe3-section-handle-access").boundingBox();
  if (!fromBox || !toBox) throw new Error("drag handles not measurable");
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2 + 10, { steps: 5 });
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 10 });
  await page.mouse.up();

  const afterDrag = await venueGroupOrder(page);
  expect(afterDrag[0]).toBe("access"); // アクセス moved to the front
  expect(afterDrag).not.toEqual(before);

  // Let the reorder's optimistic save settle (mutationFn resolve + onSettled
  // refetch) before firing the next mutation — both share one server-side version
  // lock, so racing two saves back-to-back reads a stale version and 409s.
  await page.waitForTimeout(300);

  // ── hide "持ち物・服装" (belongings) — reversible while still editing ──────
  await page.getByTestId("fe3-section-hide-belongings").click();
  await expect(page.getByTestId("fe3-section-hide-belongings")).toHaveAttribute("aria-pressed", "false");
  await page.waitForTimeout(300);

  // ── 完了 exits layout edit mode; the hidden section is gone from the resting view ──
  await page.getByTestId("fe3-layout-edit-toggle").click();
  await expect(page.getByTestId("fe3-details")).not.toHaveAttribute("data-layout-editing");
  await expect(page.getByText("持ち物・服装は未記入です。")).toHaveCount(0);

  // ── persistence: reload (same origin => same localStorage) keeps the shared
  // order + hidden state — this is the mock's stand-in for the real server round-trip ──
  await page.reload();
  await expect(page.getByTestId("fe3-details")).toBeVisible();
  await expect(page.getByText("持ち物・服装は未記入です。")).toHaveCount(0);
  await page.getByTestId("fe3-layout-edit-toggle").click();
  const reloadedOrder = await venueGroupOrder(page);
  expect(reloadedOrder[0]).toBe("access");
});

test("権限なし(event:read のみ)では並べ替えトグルも編集ボタンも出ない", async ({ page }) => {
  await page.goto("/?readonly=1");
  await selectFirstEvent(page);

  await expect(page.getByTestId("fe3-details")).toBeVisible();
  await expect(page.getByTestId("fe3-layout-edit-toggle")).toHaveCount(0);
  await expect(page.getByTestId("fe3-details-edit")).toHaveCount(0);
});
