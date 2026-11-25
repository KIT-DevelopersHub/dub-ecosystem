// Real-browser proof of the mail controls. Sanitizer bypasses through DOM clobbering do not
// reproduce in jsdom, so the HTML case can only be trusted here.
import { expect, test, type Page } from "@playwright/test";

const shots = process.env.MAIL_SHOTS;
const shot = async (page: Page, name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const open = async (page: Page): Promise<void> => {
  await page.goto("/mail");
  await expect(page.getByTestId("fe2-mail-gmail")).toBeVisible();
  await expect(page.getByTestId("fe2-mail-inbox-item").first()).toBeVisible();
};
const row = (page: Page, text: string) => page.getByTestId("fe2-mail-inbox-item").filter({ hasText: text });

test("HTML mail renders with its layout and runs nothing", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  const remote: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("placehold.co")) remote.push(r.url());
  });
  await open(page);
  await row(page, "【HTMLメール】").click();
  const body = page.getByTestId("fe2-mail-body-html");
  await expect(body.getByRole("heading", { name: "カンファレンス開催のお知らせ" })).toBeVisible();

  await page.waitForTimeout(500); // onerror handlers fire asynchronously
  expect(await page.evaluate(() => (window as unknown as { __mailXss?: number }).__mailXss)).toBeUndefined();
  expect(dialogs).toEqual([]);
  expect(await body.locator("[onerror], [onclick], script, form").count()).toBe(0);
  expect(await body.locator("a", { hasText: "危険なリンク" }).getAttribute("href")).toBeNull();
  expect(await body.locator("table").first().evaluate((el) => getComputedStyle(el).position)).toBe("static");

  await expect.poll(() => body.locator("img[data-cid]").first().evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(remote).toEqual([]);
  await shot(page, "html-images-off");
  await page.getByTestId("fe2-mail-images-show").click();
  await expect.poll(() => remote.length).toBeGreaterThan(0);
  await shot(page, "html-images-on");
});

test("a draft survives ✕ with its attachment and goes away on send", async ({ page }) => {
  await open(page);
  await page.getByTestId("fe2-mail-compose-open").click();
  await page.getByTestId("fe2-mail-compose-to").fill("bob@example.com,");
  await page.getByTestId("fe2-mail-compose-subject").fill("書きかけのメール");
  await page.getByTestId("fe2-mail-compose-attach-input").setInputFiles({ name: "memo.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByTestId("fe2-mail-attach-chip")).toHaveAttribute("data-status", "ready");
  await page.getByTestId("fe2-mail-compose-close").click();
  await expect(page.getByTestId("fe2-mail-compose-window")).toHaveCount(0);

  await page.getByTestId("fe2-mail-folder-drafts").click();
  const draft = page.getByTestId("fe2-mail-draft-row").filter({ hasText: "書きかけのメール" });
  await expect(draft).toBeVisible();
  await shot(page, "drafts-folder");
  await draft.getByTestId("fe2-mail-draft-open").click();
  await expect(page.getByTestId("fe2-mail-compose-subject")).toHaveValue("書きかけのメール");
  await expect(page.getByTestId("fe2-mail-attach-chip")).toHaveAttribute("data-status", "ready");
  await page.getByTestId("fe2-mail-compose-send").click();
  await expect(page.getByTestId("fe2-mail-send-notice")).toHaveAttribute("data-status", "sent");
  await expect(page.getByTestId("fe2-mail-drafts-empty")).toBeVisible();
});

test("既読 / 未読 survive a sync", async ({ page }) => {
  await open(page);
  const mail = row(page, "スポンサー契約書の送付");
  await mail.hover();
  await mail.getByLabel("既読にする").click();
  await page.getByTestId("fe2-mail-refresh").click();
  await page.waitForTimeout(500);
  await mail.hover();
  await expect(mail.getByLabel("未読にする")).toBeVisible();
  await mail.getByLabel("未読にする").click();
  await page.mouse.move(0, 0);
  await page.getByTestId("fe2-mail-refresh").click();
  await page.waitForTimeout(500);
  await mail.hover();
  await expect(mail.getByLabel("既読にする")).toBeVisible();
});

test("archived mail lives under すべてのメール and comes back", async ({ page }) => {
  await open(page);
  const mail = row(page, "スポンサー契約書の送付");
  await mail.hover();
  await mail.getByTestId("fe2-mail-archive").click();
  await expect(mail).toHaveCount(0);
  await page.getByTestId("fe2-mail-folder-all").click();
  await expect(mail).toBeVisible();
  await shot(page, "all-mail");
  await mail.hover();
  await mail.getByTestId("fe2-mail-move-inbox").click();
  await page.getByTestId("fe2-mail-folder-inbox").click();
  await expect(mail).toBeVisible();
});

test("a forward carries the original's file", async ({ page }) => {
  await open(page);
  await row(page, "スポンサー契約書の送付").click();
  await expect(page.getByTestId("fe2-mail-forward")).toBeEnabled();
  await page.getByTestId("fe2-mail-forward").click();
  const win = page.getByTestId("fe2-mail-compose-window");
  await expect(win.getByText("スポンサー契約書.txt")).toBeVisible();
  await expect(win.getByTestId("fe2-mail-compose-body")).toHaveValue(/Forwarded message/);
  await shot(page, "forward");
});

test("the keyboard walks the list", async ({ page }) => {
  await open(page);
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(page.locator('[data-cursor="true"]')).toHaveCount(1);
  await page.keyboard.press("?");
  await expect(page.getByTestId("fe2-mail-shortcuts")).toBeVisible();
  await shot(page, "shortcuts");
});

test("send errors explain themselves", async ({ page }) => {
  await open(page);
  await page.getByTestId("fe2-mail-compose-open").click();
  await page.getByTestId("fe2-mail-compose-send").click();
  await expect(page.getByTestId("fe2-mail-compose-error")).toContainText("宛先");
});

test("the selection toolbar blocks the selected senders", async ({ page }) => {
  await open(page);
  await page.getByTestId("fe2-mail-select-all").click();
  await shot(page, "bulk-selected");
  await page.getByTestId("fe2-mail-block-bulk").click();
  const dialog = page.getByTestId("fe2-mail-block-bulk-confirm");
  await shot(page, "bulk-block-confirm");
  await dialog.getByRole("button", { name: "ブロックする" }).click();
  await expect(page.getByTestId("fe2-mail-inbox-empty")).toBeVisible();
  await shot(page, "bulk-block-after");
});

test("全件選択 reaches past the loaded page and the toolbar fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.goto("/mail?demo_mail_bulk=120");
  await expect(page.getByTestId("fe2-mail-inbox-item").first()).toBeVisible();
  const selectAll = async (): Promise<void> => {
    await page.getByTestId("fe2-mail-select-all").click();
    await page.getByTestId("fe2-mail-select-all-bar-action").click();
    await expect(page.getByTestId("fe2-mail-select-all-bar")).toContainText(/全1\d\d件を選択中/);
  };
  const confirm = () => page.getByTestId("fe2-mail-bulk-confirm").getByRole("button", { name: "実行する" }).click();

  await selectAll();
  await expect(page.getByTestId("fe2-mail-read-all")).toBeInViewport({ ratio: 1 });
  await shot(page, "bulk-all-narrow");
  await page.getByTestId("fe2-mail-read-all").click();
  await shot(page, "bulk-all-confirm");
  await confirm();
  await expect(page.getByTestId("fe2-mail-gmail")).toHaveAttribute("data-unread", "0");
  await expect(page.getByTestId("fe2-mail-select-all-bar")).toHaveCount(0);

  // Archiving empties the folder only if the pages never loaded went too.
  await selectAll();
  await page.getByTestId("fe2-mail-archive-all").click();
  await confirm();
  await expect(page.getByTestId("fe2-mail-inbox-empty")).toBeVisible();
  await shot(page, "bulk-all-archived");
});
