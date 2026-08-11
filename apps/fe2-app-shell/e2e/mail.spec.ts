// Mail vertical slice E2E (real browser, DEMO transport) against the ONE mail UI the
// user actually uses: the Gmail-style /mail app, now wired to the live gateway. Covers:
//   (a) fresh load shows a CLEAN gateway-backed mailbox — NO hardcoded demo pile;
//   (b) opening an inbox message clears its unread badge (mark-read via the API);
//   (c) compose → send → the mail appears in Sent AND survives a full page reload
//       (persisted via GET /mail/sent, not ephemeral client state).
// The demo transport persists Sent in sessionStorage, so a reload behaves like a real
// gateway. Screenshots: Inbox, message detail, Sent-after-send.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "..", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

test("clean gateway-backed mailbox: read clears unread, compose persists to Sent across reload", async ({ page }) => {
  await page.goto("/mail");
  const app = page.getByTestId("fe2-mail-gmail");
  await expect(app).toBeVisible();

  // (a) Inbox hydrated from GET /mail/messages — a small CLEAN sample, NOT the old
  // client-seeded pile (northcloud / print-hokuriku / キックオフ threads are gone).
  const rows = page.getByTestId("fe2-mail-inbox-item");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeLessThanOrEqual(5);
  await expect(page.getByText("ノースクラウド", { exact: false })).toHaveCount(0);
  await expect(page.getByText("キックオフのお知らせ", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: shot("01-inbox.png"), fullPage: true });

  // (b) unread badge (data-unread) drops by one when the first message is opened.
  await expect(app).toHaveAttribute("data-unread", "2");
  await rows.first().click();
  await expect(page.getByTestId("fe2-mail-thread")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-body-text").first()).toBeVisible();
  await expect(app).toHaveAttribute("data-unread", "1");
  await page.screenshot({ path: shot("03-message-detail.png"), fullPage: true });
  await page.getByTestId("fe2-mail-thread-back").click();

  // Sent starts CLEAN (empty).
  await page.getByTestId("fe2-mail-folder-sent").click();
  await expect(page.getByTestId("fe2-mail-inbox-empty")).toBeVisible();

  // (c) compose → send via POST /outbox.
  const subject = `E2E 送信テスト ${Date.now()}`;
  await page.getByTestId("fe2-mail-compose-open").click();
  await expect(page.getByTestId("fe2-mail-compose-window")).toBeVisible();
  const to = page.getByTestId("fe2-mail-compose-to");
  await to.fill("teammate@example.com");
  await to.press("Enter");
  await page.getByTestId("fe2-mail-compose-subject").fill(subject);
  await page.getByTestId("fe2-mail-compose-body").fill("これはE2Eの送信本文です。");
  await page.getByTestId("fe2-mail-compose-send").click();

  // Lands in Sent; the just-sent mail is listed (read back from GET /mail/sent).
  await expect(page.getByText(subject)).toBeVisible();
  await page.screenshot({ path: shot("02-sent-after-send.png"), fullPage: true });

  // Survives a full reload — Sent is persisted server-side (mock: sessionStorage).
  await page.reload();
  await expect(page.getByTestId("fe2-mail-gmail")).toBeVisible();
  await page.getByTestId("fe2-mail-folder-sent").click();
  await expect(page.getByText(subject)).toBeVisible();
});
