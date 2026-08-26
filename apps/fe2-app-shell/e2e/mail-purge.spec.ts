// 完全に削除 (permanent per-user delete) E2E — real browser, DEMO transport (VITE_DEMO=1).
// Proves the Gmail-faithful guarantee end-to-end in a real Chromium, on top of the per-user
// trash (#437): "完全に削除" from Trash removes a conversation from THIS viewer's mailbox for
// good, but is a PER-USER view state — the message is never physically deleted, so another
// account / the oversight admin still sees it.
//   (a) a user purges from their Trash        → gone from THEIR mailbox (no restore);
//   (b) the oversight admin (mail:read_all)   → STILL sees that same conversation;
//   (c) the reverse: the admin purges         → gone from the ADMIN's view, but the owner
//                                               still sees it (independence both directions).
// Accounts switch via the demo selector (localStorage["dub_demo_account"]) + a reload, which
// re-scopes /me, the inbox AND the per-account flag store (see src/lib/demo-seed.tsx).
import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "..", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

const A_INBOX_SUBJECT = "登壇のご相談"; // seeded in the default admin (usr_demo) inbox
const B_INBOX_SUBJECT = "委員会の議事録共有"; // seeded only in account B (usr_bob)

async function switchAccount(page: Page, accountId: string): Promise<void> {
  // Establish the origin first (localStorage is per-origin) if we are still on about:blank.
  if (!page.url().startsWith("http")) await page.goto("/mail");
  await page.evaluate((id) => localStorage.setItem("dub_demo_account", id), accountId);
  await page.goto("/mail"); // reload re-scopes /me, inbox and the per-account flag store
  await expect(page.getByTestId("fe2-mail-gmail")).toBeVisible();
}

function row(page: Page, subject: string): Locator {
  return page.getByTestId("fe2-mail-inbox-item").filter({ hasText: subject });
}

/** Hover a list row to reveal its inline actions, then click one by test-id. */
async function rowAction(page: Page, subject: string, testId: string): Promise<void> {
  const r = row(page, subject).first();
  await r.hover();
  await r.getByTestId(testId).click();
}

/** Move a conversation to Trash, then 完全に削除 it (accepting the confirm dialog). */
async function trashThenPurge(page: Page, subject: string): Promise<void> {
  await rowAction(page, subject, "fe2-mail-trash"); // inbox → Trash
  await page.getByTestId("fe2-mail-folder-trash").click();
  await expect(row(page, subject)).toHaveCount(1);
  page.once("dialog", (d) => void d.accept()); // 完全に削除 asks for confirmation
  await rowAction(page, subject, "fe2-mail-purge");
}

test("(a)(b) a user's 完全に削除 hides it from THEM only — the oversight admin still sees it", async ({ page }) => {
  // ---- Account B (usr_bob): sees its own mail, then permanently deletes it ----
  await switchAccount(page, "usr_bob");
  await expect(page.getByText(B_INBOX_SUBJECT)).toBeVisible();

  await trashThenPurge(page, B_INBOX_SUBJECT);
  // (a) Gone from THIS user's Trash for good (no restore path is offered).
  await expect(row(page, B_INBOX_SUBJECT)).toHaveCount(0);
  await page.getByTestId("fe2-mail-folder-inbox").click();
  await expect(page.getByText(B_INBOX_SUBJECT)).toHaveCount(0); // and not back in the inbox
  await page.screenshot({ path: shot("purge-01-user-trash-empty.png"), fullPage: true });

  // ---- Oversight admin (usr_super / info@, mail:read_all): STILL sees the conversation ----
  await switchAccount(page, "usr_super");
  // (b) The message was never physically deleted — the admin's view is unaffected.
  await expect(page.getByText(B_INBOX_SUBJECT)).toBeVisible();
  await page.screenshot({ path: shot("purge-02-admin-still-sees.png"), fullPage: true });
});

test("(c) the reverse: the admin's 完全に削除 hides it from the ADMIN only — the owner still sees it", async ({ page }) => {
  // ---- Oversight admin purges a conversation that belongs to the default user ----
  await switchAccount(page, "usr_super");
  await expect(page.getByText(A_INBOX_SUBJECT)).toBeVisible();

  await trashThenPurge(page, A_INBOX_SUBJECT);
  await expect(row(page, A_INBOX_SUBJECT)).toHaveCount(0); // gone from the ADMIN's mailbox
  await page.screenshot({ path: shot("purge-03-admin-trash-empty.png"), fullPage: true });

  // ---- The owner (usr_demo) still sees their own conversation, untouched ----
  await switchAccount(page, "usr_demo");
  await expect(page.getByText(A_INBOX_SUBJECT)).toBeVisible();
  await page.screenshot({ path: shot("purge-04-owner-still-sees.png"), fullPage: true });
});
