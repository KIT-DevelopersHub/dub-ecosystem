// Keyboard-shortcuts help E2E (real browser, DEMO transport). Proves:
//   (1) 設定 (⚙) → キーボードショートカット opens the list dialog;
//   (2) the list is derived from the shortcut registry — it shows the command-palette
//       Cmd/Ctrl+K row AND lists its own "?" hotkey;
//   (3) the global "?" hotkey opens the same dialog from anywhere;
//   (4) Cmd/Ctrl+K (the registry-bound palette toggle) still opens the palette.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "fe2-shortcuts");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

test("keyboard shortcuts: open from 設定, lists registry entries, '?' + Cmd/Ctrl+K work", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("fe2-home")).toBeVisible();

  // (1) 設定 (⚙) → キーボードショートカット opens the dialog.
  await page.getByTestId("fe2-settings-menu-trigger").click();
  await page.getByTestId("fe2-shortcuts-open").click();
  const dialog = page.getByTestId("fe2-shortcuts");
  await expect(dialog).toBeVisible();

  // (2) The list is registry-driven: the palette shortcut and the self-listed "?" appear.
  const paletteRow = page.getByTestId("fe2-shortcuts-row-command-palette");
  await expect(paletteRow).toBeVisible();
  await expect(paletteRow).toContainText("K");
  const helpRow = page.getByTestId("fe2-shortcuts-row-shortcuts-help");
  await expect(helpRow).toBeVisible();
  await expect(helpRow).toContainText("?");
  await page.waitForTimeout(400); // let the overlay finish fading in before the shot
  await page.screenshot({ path: shot("shortcuts-dialog.png") });

  // Close it (Esc) before testing the hotkey path.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // (3) Global "?" hotkey opens the same dialog from anywhere.
  await page.keyboard.press("?");
  await expect(page.getByTestId("fe2-shortcuts")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("fe2-shortcuts")).toBeHidden();

  // (4) The registry-bound Cmd/Ctrl+K still opens the command palette.
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("fe2-cmdk")).toBeVisible();
  await page.screenshot({ path: shot("command-palette.png") });
});
