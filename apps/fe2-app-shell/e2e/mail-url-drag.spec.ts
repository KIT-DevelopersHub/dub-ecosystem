// Mail reading-pane URLs + draggable compose window (real browser, DEMO transport).
//   (a) bare URLs in a received body render as links that open in a new tab, stopping
//       before Japanese brackets / angle brackets, and the body never overflows sideways;
//   (b) the floating compose window moves by dragging its title bar, stays on screen,
//       and re-docks when minimized.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "..", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

test("received mail URLs render as clean links", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/mail");
  await expect(page.getByTestId("fe2-mail-gmail")).toBeVisible();
  await page.getByText("【期間限定】今だけ全品50%オフのご案内").first().click();
  const links = page.getByTestId("fe2-mail-body-link");
  await expect(links).toHaveCount(3);
  await expect(links.nth(1)).toHaveAttribute("href", "https://deals-mail.example/lp");
  await expect(links.nth(2)).toHaveAttribute("href", /^https:\/\/deals-mail\.example\/unsubscribe\?token=[^>]+$/);
  await expect(links.first()).toHaveAttribute("target", "_blank");
  const body = page.getByTestId("fe2-mail-body-text");
  const { sw, cw } = await body.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
  await page.screenshot({ path: shot("mail-url-links.png") });
});

test("compose window can be dragged by its title bar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/mail");
  await expect(page.getByTestId("fe2-mail-gmail")).toBeVisible();
  await page.getByTestId("fe2-mail-compose-open").click();
  const win = page.getByTestId("fe2-mail-compose-window");
  const header = page.getByTestId("fe2-mail-compose-header");
  const before = (await win.boundingBox())!;
  const h = (await header.boundingBox())!;
  await page.mouse.move(h.x + 60, h.y + 20);
  await page.mouse.down();
  await page.mouse.move(h.x - 400, h.y - 200, { steps: 8 });
  await page.mouse.up();
  const after = (await win.boundingBox())!;
  expect(Math.round(after.x)).toBe(Math.round(before.x - 460));
  expect(Math.round(after.y)).toBe(Math.round(before.y - 220));
  await page.screenshot({ path: shot("mail-compose-dragged.png") });

  // Dragging far off-screen is clamped to the viewport.
  const h2 = (await header.boundingBox())!;
  await page.mouse.move(h2.x + 60, h2.y + 20);
  await page.mouse.down();
  await page.mouse.move(-500, -500, { steps: 4 });
  await page.mouse.up();
  const clamped = (await win.boundingBox())!;
  expect(clamped.x).toBe(0);
  expect(clamped.y).toBe(0);

  // Typing still works after a drag; minimize docks it to the bottom edge.
  await page.getByTestId("fe2-mail-compose-subject").fill("移動テスト");
  await page.getByRole("button", { name: "最小化" }).click();
  const docked = (await win.boundingBox())!;
  expect(Math.round(docked.y + docked.height)).toBe(800);
  // Restoring returns to the moved position.
  await header.dispatchEvent("click"); // the demo-mode banner overlays the docked bar
  const restored = (await win.boundingBox())!;
  expect(restored.x).toBe(0);
  expect(restored.y).toBe(0);
  await expect(page.getByTestId("fe2-mail-compose-subject")).toHaveValue("移動テスト");
});
