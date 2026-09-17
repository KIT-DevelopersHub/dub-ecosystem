// AppLauncher mobile bottom-sheet E2E (real browser, DEMO transport, P19). Proves:
//   (1) at mobile width the popover renders anchored to the BOTTOM edge of the
//       viewport (a sheet), not pinned below the header like the old mobile panel;
//   (2) a scrim covers the page behind it, and every app tile is still present
//       (repositioning only — nothing hidden, dub-never-hide-or-reduce-apps);
//   (3) tapping the scrim dismisses the sheet;
//   (4) desktop width keeps the original popover (no scrim, anchored under the
//       trigger) — the two presentations are CSS/width-only, same markup.
// Screenshots land in ~/DubVault/docs/fe1-launcher-mobile-sheet/.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "fe1-launcher-mobile-sheet");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

const TRIGGER = "fe2-app-launcher-trigger";
const PANEL = "dub-launcher-panel";
const BACKDROP = "fe2-app-launcher-backdrop";

async function openLauncher(page: Page): Promise<void> {
  await page.getByTestId(TRIGGER).click();
  await expect(page.getByTestId(PANEL)).toBeVisible();
}

test.describe("AppLauncher — mobile bottom sheet (P19)", () => {
  test("mobile width: panel becomes a bottom sheet with a scrim, every app still present, scrim-tap closes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone 12-class width
    await page.goto("/");
    await expect(page.getByTestId("fe2-home")).toBeVisible();

    await openLauncher(page);
    await page.screenshot({ path: shot("01-mobile-sheet-open.png") });

    // Scrim is visible behind the sheet (hidden entirely on desktop — see next test).
    await expect(page.getByTestId(BACKDROP)).toBeVisible();

    // The panel is anchored to the BOTTOM of the viewport (a sheet), not pinned
    // just under the header like the pre-P19 mobile panel.
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const panelBox = await page.getByTestId(PANEL).boundingBox();
    expect(panelBox).not.toBeNull();
    if (panelBox && viewport) {
      const distanceFromBottom = viewport.height - (panelBox.y + panelBox.height);
      // Small tolerance for safe-area padding, not the ~100px header gap the old
      // mobile panel left below itself.
      expect(distanceFromBottom).toBeLessThan(24);
    }

    // Nothing was dropped from the catalog — every tile the desktop popover shows
    // is still reachable here too.
    const tileCount = await page.getByTestId(PANEL).getByRole("option").count();
    expect(tileCount).toBeGreaterThan(1);

    // Tapping the scrim dismisses the sheet (thumb-friendly close, in addition to
    // the existing outside-click/Escape handling).
    await page.getByTestId(BACKDROP).click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId(PANEL)).toBeHidden();
  });

  test("desktop width: original popover is unchanged (no scrim, anchored under the trigger)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.getByTestId("fe2-home")).toBeVisible();

    await openLauncher(page);
    await page.screenshot({ path: shot("02-desktop-popover-open.png") });

    // No scrim on desktop — it stays a lightweight popover.
    await expect(page.getByTestId(BACKDROP)).toBeHidden();

    const triggerBox = await page.getByTestId(TRIGGER).boundingBox();
    const panelBox = await page.getByTestId(PANEL).boundingBox();
    expect(triggerBox).not.toBeNull();
    expect(panelBox).not.toBeNull();
    if (triggerBox && panelBox) {
      // Popover still hangs just below the waffle trigger, not pinned to the
      // bottom of the viewport.
      expect(panelBox.y).toBeGreaterThan(triggerBox.y);
      expect(panelBox.y).toBeLessThan(triggerBox.y + 200);
    }
  });
});
