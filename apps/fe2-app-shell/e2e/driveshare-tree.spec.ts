// Hackit Drive sharing manager — TREE view E2E (real browser, DEMO transport / mock
// Drive). Proves the lazy hierarchy end-to-end:
//   (a) the root renders as a collapsed tree (deeper children are NOT in the DOM yet);
//   (b) expanding a folder lazily loads and nests its direct children (aria-level 2);
//   (c) a second-level folder expands to a depth-3 child (aria-level 3);
//   (d) selecting a nested node opens its sharing panel;
//   (e) granting a role to that node shows the role-grant row AND a chip on the node.
// No real Google Drive is touched; the in-session demo store survives the SPA clicks.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "/Users/kota/DubVault/docs/driveshare-tree-review";
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => `${SHOTS}/${name}`;

const node = (id: string) => `[data-node-id="${id}"]`;

test("expand folder → nested children → select child → grant a role", async ({ page }) => {
  await page.goto("/driveshare");
  await expect(page.getByTestId("fe2-driveshare")).toBeVisible();

  // (a) tree renders, root folder present, deeper child not yet in the DOM.
  await expect(page.getByTestId("fe2-driveshare-tree")).toBeVisible();
  await expect(page.locator(node("fld_root"))).toBeVisible();
  await expect(page.locator(node("fld_sponsors"))).toHaveCount(0);
  await page.screenshot({ path: shot("01-tree-root.png"), fullPage: true });

  // (b) expand fld_root → its direct children appear, nested at aria-level 2.
  await page.locator(`${node("fld_root")} [data-testid="fe2-driveshare-toggle"]`).first().click();
  await expect(page.locator(node("fld_sponsors"))).toBeVisible();
  await expect(page.locator(node("fil_schedule"))).toBeVisible();
  await expect(page.locator(node("fld_sponsors"))).toHaveAttribute("aria-level", "2");
  await page.screenshot({ path: shot("02-expanded-nested.png"), fullPage: true });

  // (c) expand the second-level folder → a depth-3 child (aria-level 3).
  await page.locator(`${node("fld_sponsors")} [data-testid="fe2-driveshare-toggle"]`).first().click();
  await expect(page.locator(node("fil_contract"))).toBeVisible();
  await expect(page.locator(node("fil_contract"))).toHaveAttribute("aria-level", "3");

  // (d) select the nested file → its sharing panel opens.
  await page.locator(`${node("fil_contract")} [data-testid="fe2-driveshare-file"]`).first().click();
  await expect(page.getByTestId("fe2-driveshare-panel")).toBeVisible();
  await expect(page.getByTestId("fe2-driveshare-panel")).toContainText("協賛契約書");
  await page.screenshot({ path: shot("03-node-selected.png"), fullPage: true });

  // (e) grant a role (maintainer / 編集) → the role-grant row and the node chip appear.
  await page.getByTestId("fe2-driveshare-role-picker").selectOption("role_maintainer");
  await page.getByTestId("fe2-driveshare-role-driverole").selectOption("writer");
  await page.getByTestId("fe2-driveshare-role-submit").click();
  await expect(page.getByTestId("fe2-driveshare-role-grant")).toBeVisible();
  // the chip shows on the selected node in the tree (indexed from the all-grants query).
  await expect(
    page.locator(`${node("fil_contract")} [data-testid="fe2-driveshare-file-chip"]`),
  ).toContainText("maintainer");
  await page.screenshot({ path: shot("04-role-chip.png"), fullPage: true });
});

test("keyboard: arrow-right expands, arrow-down moves, Enter selects", async ({ page }) => {
  await page.goto("/driveshare");
  await expect(page.getByTestId("fe2-driveshare-tree")).toBeVisible();

  // focus the first root treeitem (roving tab stop) and drive it by keyboard.
  const first = page.locator('[role="treeitem"]').first();
  await first.focus();
  await page.keyboard.press("ArrowRight"); // expand fld_root
  await expect(page.locator(node("fld_sponsors"))).toBeVisible();
  await page.keyboard.press("ArrowDown"); // move into first child
  await page.keyboard.press("Enter"); // select it
  await expect(page.getByTestId("fe2-driveshare-panel")).toBeVisible();
});
