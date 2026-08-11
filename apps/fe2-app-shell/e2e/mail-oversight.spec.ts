// Mail oversight + archive-CC E2E (real browser, DEMO transport). Proves the two new
// guarantees end-to-end in a real Chromium, on top of the #169 per-account isolation:
//   ② a mail:read_all account (監督 / info@developershub.jp) sees EVERY account's mail,
//      while a personal account sees only its own (isolation, contrast);
//   ③ every send auto-CCs the fixed archive address (archive@developershub.jp).
// Accounts are switched via the demo selector (localStorage["dub_demo_account"]) + a
// reload, which re-scopes /me, the inbox and the Sent folder. The demo transport enforces
// the same read_all bypass + archive-CC the mail-gateway does (see src/lib/demo-seed.tsx).
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, "..", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => join(SHOTS, name);

const A_INBOX_SUBJECT = "登壇のご相談"; // seeded only in account A's inbox
const B_INBOX_SUBJECT = "委員会の議事録共有"; // seeded only in account B's inbox
const ARCHIVE = "archive@developershub.jp";

async function switchAccount(page: Page, accountId: string, landing = "/mail/inbox"): Promise<void> {
  await page.evaluate((id) => localStorage.setItem("dub_demo_account", id), accountId);
  await page.goto(landing);
}

async function openSent(page: Page): Promise<void> {
  await page.getByTestId("fe2-mail-folders-tab-sent").click();
  await expect(page.getByTestId("fe2-mail-sent")).toBeVisible();
}

async function composeSend(page: Page, subject: string): Promise<void> {
  await page.getByTestId("fe2-mail-sent-compose").click();
  await expect(page.getByTestId("fe2-mail-compose")).toBeVisible();
  await page.getByTestId("fe2-mail-compose-to").fill("someone@example.com");
  await page.getByTestId("fe2-mail-compose-subject").fill(subject);
  await page.getByTestId("fe2-mail-compose-body").fill("本文です。");
  await page.getByTestId("fe2-mail-compose-send").click();
  await expect(page.getByTestId("fe2-mail-sent")).toBeVisible();
}

test("③ every send auto-CCs the fixed archive address", async ({ page }) => {
  await page.goto("/mail/inbox");
  await expect(page.getByTestId("fe2-mail-inbox")).toBeVisible();
  await openSent(page);

  const subject = `アーカイブCC ${Date.now()}`;
  await composeSend(page, subject);

  // Open the just-sent mail's detail — its Cc line must carry the archive address.
  await page.getByText(subject).first().click();
  await expect(page.getByTestId("fe2-mail-sent-detail")).toBeVisible();
  await expect(page.getByText(new RegExp(ARCHIVE))).toBeVisible();
  await page.screenshot({ path: shot("ovr-03-archive-cc.png"), fullPage: true });
});

test("② a mail:read_all account sees every account's mail (oversight)", async ({ page }) => {
  // ---- Account A: its own inbox + send a mail that lands in A's Sent ----
  await page.goto("/mail/inbox");
  await expect(page.getByTestId("fe2-mail-inbox")).toBeVisible();
  await expect(page.getByText(A_INBOX_SUBJECT)).toBeVisible();
  await expect(page.getByText(B_INBOX_SUBJECT)).toHaveCount(0); // A never sees B's mail

  await openSent(page);
  const subject = `監督テスト送信 ${Date.now()}`;
  await composeSend(page, subject);
  await expect(page.getByText(subject)).toBeVisible();

  // ---- Switch to the oversight account (監督 / info@) with mail:read_all ----
  await switchAccount(page, "usr_super", "/mail/inbox");
  await expect(page.getByTestId("fe2-mail-inbox")).toBeVisible();
  // Sees BOTH A's and B's received mail — the whole org's inbox.
  await expect(page.getByText(A_INBOX_SUBJECT)).toBeVisible();
  await expect(page.getByText(B_INBOX_SUBJECT)).toBeVisible();
  await page.screenshot({ path: shot("ovr-02-oversight-inbox.png"), fullPage: true });

  // And sees A's sent mail in the aggregated Sent folder.
  await openSent(page);
  await expect(page.getByText(subject)).toBeVisible();
  await page.screenshot({ path: shot("ovr-02b-oversight-sent.png"), fullPage: true });

  // ---- Contrast: a personal account (B) does NOT see A's sent nor read_all ----
  await switchAccount(page, "usr_bob", "/mail/inbox");
  await expect(page.getByText(B_INBOX_SUBJECT)).toBeVisible();
  await expect(page.getByText(A_INBOX_SUBJECT)).toHaveCount(0);
  await openSent(page);
  await expect(page.getByText(subject)).toHaveCount(0); // A's sent invisible to B
  await page.screenshot({ path: shot("ovr-01-personal-scoped.png"), fullPage: true });
});
