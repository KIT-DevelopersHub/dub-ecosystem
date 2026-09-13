// P16: real-browser proof of the @dub/ui Modal/Dialog focus trap.
//
// The vitest suite (test/Modal.test.tsx) already covers this logic in jsdom, but
// jsdom's focus/Tab semantics are a simulation — this spec drives an actual
// Chromium browser against the built Storybook catalog's isolated `iframe.html`
// (same technique as stories.spec.ts, no screenshots here) to prove real keyboard
// behaviour: initial focus on open, Tab/Shift+Tab cycling that never escapes the
// dialog, Escape-to-close, and focus restoring to the element that opened it.
import { test, expect, type Page } from "@playwright/test";

// "Overlay/Modal" → "Default" story: a trigger button + Modal with a footer of two
// plain buttons and no input field in the body, so initial focus falls back to the
// header's close (X) button — exercising the full trap end-to-end with the
// smallest number of moving parts.
const STORY_ID = "overlay-modal--default";

async function gotoStory(page: Page) {
  await page.goto(`/iframe.html?id=${STORY_ID}&viewMode=story`);
  await page.locator("#storybook-root").waitFor({ state: "attached" });
}

test.describe("@dub/ui Modal focus trap (P16)", () => {
  test("moves focus in on open, cycles Tab/Shift+Tab without escaping, Esc closes, and focus returns to the trigger", async ({
    page,
  }) => {
    await gotoStory(page);

    const trigger = page.getByRole("button", { name: "モーダルを開く" });
    await trigger.focus();
    await trigger.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");

    // Initial focus: no input in the body, so it falls back to the first focusable
    // element in the dialog — the header's 閉じる (close) button.
    const closeBtn = page.getByLabel("閉じる");
    await expect(closeBtn).toBeFocused();

    // Tab order inside the dialog: 閉じる → キャンセル → 保存 → wraps back to 閉じる.
    const cancelBtn = page.getByRole("button", { name: "キャンセル" });
    const saveBtn = page.getByRole("button", { name: "保存" });

    await page.keyboard.press("Tab");
    await expect(cancelBtn).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(saveBtn).toBeFocused();

    // Forward Tab from the LAST item wraps to the FIRST — never escapes the dialog
    // to the browser chrome or anything behind the overlay.
    await page.keyboard.press("Tab");
    await expect(closeBtn).toBeFocused();

    // Shift+Tab from the FIRST item wraps to the LAST.
    await page.keyboard.press("Shift+Tab");
    await expect(saveBtn).toBeFocused();

    // Escape closes the dialog…
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // …and focus is restored to the element that opened it, not lost to <body>.
    await expect(trigger).toBeFocused();
  });
});
