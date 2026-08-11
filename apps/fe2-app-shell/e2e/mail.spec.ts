// Mail vertical slice E2E (real browser, DEMO transport). Covers:
//   (a) compose → send → the mail appears in the Sent folder;
//   (b) the inbox lists the seeded received mail and opening one clears its unread badge;
//   (c) Inbox + Sent show a CLEAN state (a small sample set + an initially empty Sent),
//       never the "weird demo pile" (which was live prod rows, not seed data).
// All navigation after the first goto is SPA (in-app clicks) so the in-memory demo
// mail store — where the just-sent message lives — survives until the assertion.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "..", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

test("compose → send → Sent, and opening an inbox message clears its unread badge", async ({ page }) => {
  // ---- Inbox: seeded received mail, CLEAN small set ----
  await page.goto("/mail/inbox");
  await expect(page.getByTestId("fe2-mail-inbox")).toBeVisible();
  const rows = page.getByTestId("fe2-mail-inbox-item");
  await expect(rows.first()).toBeVisible();
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);
  expect(rowCount).toBeLessThanOrEqual(5); // clean sample, not a demo pile
  await page.screenshot({ path: shot("01-inbox.png"), fullPage: true });

  // (b) unread badges present, then opening the first message clears one.
  const unreadBefore = await page.getByTestId("fe2-mail-inbox-unread").count();
  expect(unreadBefore).toBeGreaterThan(0);

  await rows.first().click();
  await expect(page.getByTestId("fe2-mail-thread")).toBeVisible();
  await page.screenshot({ path: shot("03-message-detail.png"), fullPage: true });
  await page.getByTestId("fe2-mail-thread-back").click();

  await expect(page.getByTestId("fe2-mail-inbox")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-inbox-unread")).toHaveCount(unreadBefore - 1);

  // ---- Sent starts CLEAN (empty) ----
  await page.getByTestId("fe2-mail-folders-tab-sent").click();
  await expect(page.getByTestId("fe2-mail-sent")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-sent-empty")).toBeVisible();

  // ---- (a) compose → send ----
  const subject = `E2E 送信テスト ${Date.now()}`;
  await page.getByTestId("fe2-mail-sent-compose").click();
  await expect(page.getByTestId("fe2-mail-compose")).toBeVisible();
  await page.getByTestId("fe2-mail-compose-to").fill("teammate@example.com");
  await page.getByTestId("fe2-mail-compose-subject").fill(subject);
  await page.getByTestId("fe2-mail-compose-body").fill("これはE2Eの送信本文です。");
  await page.getByTestId("fe2-mail-compose-send").click();

  // Post-send redirect lands in Sent; the just-sent mail is listed.
  await expect(page.getByTestId("fe2-mail-sent")).toBeVisible();
  const sentRows = page.getByTestId("fe2-mail-sent-item");
  await expect(sentRows).toHaveCount(1);
  await expect(page.getByText(subject)).toBeVisible();
  await page.screenshot({ path: shot("02-sent-after-send.png"), fullPage: true });

  // Opening the sent message shows its full body.
  await sentRows.first().click();
  await expect(page.getByTestId("fe2-mail-sent-detail")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-sent-body-text")).toContainText("これはE2Eの送信本文です。");
});
