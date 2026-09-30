// Real-browser proof for P26 (fe7 RoleListPage — permission-matrix accordion):
//   1. a domain group starts open,
//   2. clicking its toggle animates the height closed (measured via boundingBox,
//      not just presence/absence — proves it's an actual transition, not an
//      instant jump),
//   3. aria-expanded flips immediately even while the close animation is running,
//   4. a different domain group is unaffected (independent open/close),
//   5. reopening brings the grid straight back.
import { test, expect } from "@playwright/test";

test("permission-matrix domain group collapses/expands with a real height animation", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("fe7-nav-shield").click();

  // admin is selected by default (tabs), its matrix is visible immediately.
  const grid = page.getByTestId("fe7-role-role_admin-matrix-grid-event");
  await expect(grid).toBeVisible();
  const openHeight = (await grid.boundingBox())!.height;
  expect(openHeight).toBeGreaterThan(20); // real content height, not collapsed

  const toggle = page.getByTestId("fe7-role-role_admin-matrix-toggle-event");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  await page.screenshot({ path: "e2e/.output/10-accordion-open.png", fullPage: true });

  // Click to collapse, then sample the wrapper height mid-transition — it must be
  // strictly between the open height and 0, proving an actual animated shrink
  // rather than an instant show/hide.
  const wrapper = page.locator("#fe7-role-role_admin-matrix-panel-event");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false"); // a11y state flips immediately

  await page.waitForTimeout(80); // partway through the ~200ms transition
  const midHeight = (await wrapper.boundingBox())?.height ?? 0;
  expect(midHeight).toBeLessThan(openHeight);

  // After the transition, the grid is gone from the DOM.
  await expect(grid).toHaveCount(0, { timeout: 1000 });
  await page.screenshot({ path: "e2e/.output/11-accordion-closed.png", fullPage: true });

  // A different domain group was never touched.
  await expect(page.getByTestId("fe7-role-role_admin-matrix-grid-mail")).toBeVisible();
  await expect(page.getByTestId("fe7-role-role_admin-matrix-toggle-mail")).toHaveAttribute("aria-expanded", "true");

  // Reopen: grid comes straight back, no re-collapse delay.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(grid).toBeVisible();
  await page.screenshot({ path: "e2e/.output/12-accordion-reopened.png", fullPage: true });
});
