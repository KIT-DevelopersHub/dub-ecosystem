// Per-account mail isolation E2E (real browser, DEMO transport). Proves the Gmail-style
// guarantee end-to-end in a real Chromium: each signed-in account sees ONLY its own sent
// and received mail. Two demo accounts (A = デモ 管理者 / demo@developershub.jp,
// B = 佐藤 太郎 / taro@developershub.jp) are switched via the demo account selector
// (localStorage["dub_demo_account"]) + a reload, which re-scopes /me, the inbox and the
// Sent folder. The demo transport enforces the same owner-scope the mail-gateway does
// (see src/lib/demo-seed.tsx), so what the browser renders reflects the server contract.
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

/** Switch the active demo account and reload so the whole shell re-scopes. */
async function switchAccount(page: Page, accountId: string, landing = "/mail/inbox"): Promise<void> {
  await page.evaluate((id) => localStorage.setItem("dub_demo_account", id), accountId);
  await page.goto(landing);
}

async function openSent(page: Page): Promise<void> {
  await page.getByTestId("fe2-mail-folders-tab-sent").click();
  await expect(page.getByTestId("fe2-mail-sent")).toBeVisible();
}

test("each account sees only its own sent + received mail (A ⇄ B isolation)", async ({ page }) => {
  // ---- Account A: inbox is A's, then send a mail that lands in A's Sent ----
  await page.goto("/mail/inbox");
  await expect(page.getByTestId("fe2-mail-inbox")).toBeVisible();
  await expect(page.getByText(A_INBOX_SUBJECT)).toBeVisible();
  await expect(page.getByText(B_INBOX_SUBJECT)).toHaveCount(0); // never B's mail
  await page.screenshot({ path: shot("iso-01-A-inbox.png"), fullPage: true });

  await openSent(page);
  await expect(page.getByTestId("fe2-mail-sent-empty")).toBeVisible();

  const subject = `A専用送信 ${Date.now()}`;
  await page.getByTestId("fe2-mail-sent-compose").click();
  await expect(page.getByTestId("fe2-mail-compose")).toBeVisible();
  await page.getByTestId("fe2-mail-compose-to").fill("someone@example.com");
  await page.getByTestId("fe2-mail-compose-subject").fill(subject);
  await page.getByTestId("fe2-mail-compose-body").fill("これはアカウントAだけの送信です。");
  await page.getByTestId("fe2-mail-compose-send").click();

  await expect(page.getByTestId("fe2-mail-sent")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-sent-item")).toHaveCount(1);
  await expect(page.getByText(subject)).toBeVisible();
  await page.screenshot({ path: shot("iso-02-A-sent.png"), fullPage: true });

  // ---- Switch to account B: A's sent is INVISIBLE, inbox is B's own ----
  await switchAccount(page, "usr_bob", "/mail/inbox");
  await expect(page.getByTestId("fe2-mail-inbox")).toBeVisible();
  await expect(page.getByText(B_INBOX_SUBJECT)).toBeVisible();
  await expect(page.getByText(A_INBOX_SUBJECT)).toHaveCount(0); // A's received mail hidden
  await page.screenshot({ path: shot("iso-03-B-inbox.png"), fullPage: true });

  await openSent(page);
  await expect(page.getByTestId("fe2-mail-sent-empty")).toBeVisible(); // B's Sent is empty
  await expect(page.getByText(subject)).toHaveCount(0); // A's sent mail is NOT visible to B
  await page.screenshot({ path: shot("iso-04-B-sent-empty.png"), fullPage: true });

  // ---- Switch back to A: A's sent still there (persisted + isolated both ways) ----
  await switchAccount(page, "usr_demo", "/mail/sent");
  await expect(page.getByTestId("fe2-mail-sent")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-sent-item")).toHaveCount(1);
  await expect(page.getByText(subject)).toBeVisible();
});
