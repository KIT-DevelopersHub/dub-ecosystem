// Gmail-parity attachment E2E (real browser, DEMO transport). Drives the /mail 3-pane
// GmailApp compose window: clip-attach multiple files (image thumbnail + doc chip), a
// forbidden .exe refused with a visible error, remove, then send → the attachment rides to
// the Sent folder and downloads back. Also opens a received message with an inline image.
// Screenshots land in ~/DubVault/docs/mail-attach-gmail/ for the PR / review.
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SHOTS = join(homedir(), "DubVault", "docs", "mail-attach-gmail");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

// Temp fixture files written to the Playwright output dir (setInputFiles needs real paths).
const TMP = join(homedir(), "DubVault", "docs", "mail-attach-gmail", ".fixtures");
mkdirSync(TMP, { recursive: true });
const PNG_8x8 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGNkYPhfz0AEYBpVSF+FAP7pAv4prsMnAAAAAElFTkSuQmCC",
  "base64",
);
const imgPath = join(TMP, "設計スケッチ.png");
const docPath = join(TMP, "議事録.txt");
const exePath = join(TMP, "setup.exe");
writeFileSync(imgPath, PNG_8x8);
writeFileSync(docPath, "E2E デモ用の議事録テキストです。\n添付ファイル機能の確認。");
writeFileSync(exePath, Buffer.from([0x4d, 0x5a, 0x90, 0x00])); // "MZ" — a fake executable

test("Gmail-style compose: attach image + doc, refuse .exe, remove, send, and inline received image", async ({ page }) => {
  await page.goto("/mail");
  // The demo-only banner is pinned to the bottom edge and overlaps the floating compose's
  // send button; hide it so clicks/screenshots reflect the real (banner-free) app.
  await page.addStyleTag({ content: '[role="note"]{display:none !important}' });
  await expect(page.getByTestId("fe2-mail-gmail")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-inbox-item").first()).toBeVisible();

  // ---- open the floating compose window ----
  await page.getByTestId("fe2-mail-compose-open").click();
  await expect(page.getByTestId("fe2-mail-compose-window")).toBeVisible();
  await page.getByTestId("fe2-mail-compose-to").fill("teammate@example.com");
  await page.getByTestId("fe2-mail-compose-subject").fill("添付テスト（Gmail相当）");
  await page.getByTestId("fe2-mail-compose-body").fill("画像と文書を添付します。実行ファイルは拒否されます。");

  // ---- attach an image + a document (multiple) ----
  await page.getByTestId("fe2-mail-compose-attach-input").setInputFiles([imgPath, docPath]);
  await expect(page.getByTestId("fe2-mail-attach-chip")).toHaveCount(2);
  // both settle to "ready" (read complete)
  await expect(page.locator('[data-testid="fe2-mail-attach-chip"][data-status="ready"]')).toHaveCount(2);
  await page.screenshot({ path: shot("01-compose-attachments.png"), fullPage: true });

  // ---- a forbidden executable is refused with a visible error, no chip added ----
  await page.getByTestId("fe2-mail-compose-attach-input").setInputFiles([exePath]);
  await expect(page.getByTestId("fe2-mail-attach-errors")).toContainText("セキュリティ");
  await expect(page.getByTestId("fe2-mail-attach-chip")).toHaveCount(2); // still just the 2 valid
  await page.screenshot({ path: shot("02-forbidden-exe-blocked.png"), fullPage: true });

  // ---- remove the document chip (individual ×) ----
  await page.getByTestId("fe2-mail-attach-remove").nth(1).click();
  await expect(page.getByTestId("fe2-mail-attach-chip")).toHaveCount(1);

  // ---- send: the remaining image attachment rides to the Sent folder ----
  await page.getByTestId("fe2-mail-compose-send").click();
  await expect(page.getByTestId("fe2-mail-compose-window")).toBeHidden();
  await page.getByTestId("fe2-mail-folder-sent").click();
  const sentRows = page.getByTestId("fe2-mail-inbox-item");
  await expect(sentRows.first()).toBeVisible();
  await sentRows.first().click();
  // Sent message shows the attachment (inline image thumbnail for the png).
  await expect(page.getByTestId("fe2-mail-attachment-image").first()).toBeVisible();
  await page.screenshot({ path: shot("03-sent-with-attachment.png"), fullPage: true });

  // ---- received side: open the seeded inbox message that carries an inline image ----
  await page.getByTestId("fe2-mail-folder-inbox").click();
  await page.getByText("登壇のご相談").click();
  await expect(page.getByTestId("fe2-mail-thread")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-attachment-image").first()).toBeVisible();
  await page.screenshot({ path: shot("04-received-inline-image.png"), fullPage: true });
});
