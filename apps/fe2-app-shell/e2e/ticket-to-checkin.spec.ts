// チケット購入 → 決済（Stripe テストモード）→ 発券 → 当日受付 をブラウザで通す（#897）。
// 設定は playwright.tickets.config.ts（`pnpm e2e:tickets`）。API だけの版は packages/e2e-smoke/test/ticket-to-checkin.test.ts。
import { expect, test, type Page } from "@playwright/test";

const STACK = `http://127.0.0.1:${process.env.TICKET_E2E_STACK_PORT ?? 5216}`;
const TEST_CARD_OK = "4242 4242 4242 4242";
const TEST_CARD_DECLINED = "4000 0000 0000 0002";

interface Mail {
  to: string;
  ticketUrls: string[];
}

async function reset(page: Page) {
  const res = await page.request.post(`${STACK}/__e2e/reset`, {
    data: {
      types: [
        { name: "一般", description: "", priceJpy: 3000, capacity: 100, active: true, dayLabel: "" },
        { name: "招待", description: "", priceJpy: 0, capacity: 20, active: true, dayLabel: "" },
      ],
    },
  });
  expect(res.ok()).toBe(true);
  const { types } = (await res.json()) as { types: { id: string; name: string }[] };
  return { paid: types[0]!, free: types[1]! };
}

async function ticketUrls(page: Page): Promise<string[]> {
  const mails = (await (await page.request.get(`${STACK}/__e2e/mails`)).json()) as Mail[];
  return mails.filter((m) => m.to === "hanako@example.com").flatMap((m) => m.ticketUrls);
}

async function fillBuyer(page: Page, typeId: string, qty: string) {
  await page.goto(`${STACK}/tickets`, { waitUntil: "domcontentloaded" });
  await page.locator(`select[name="qty_${typeId}"]`).selectOption(qty);
  await page.locator('input[name="name"]').fill("北陸 花子");
  await page.locator('input[name="email"]').fill("hanako@example.com");
}

async function checkIn(page: Page, code: string) {
  await page.getByTestId("fe2-lp-checkin-code").fill(code);
  await page.getByTestId("fe2-lp-checkin-submit").click();
}

test.beforeEach(async ({ context }) => {
  // 公開 LP は Google Fonts を読む。CI で外へ出ないよう止める（見た目は変わるが流れは同じ）。
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
});

test("paid: LP -> Stripe test checkout -> ticket page with QR -> reception checks in once", async ({ page }) => {
  const { paid } = await reset(page);

  await fillBuyer(page, paid.id, "1");
  await page.locator("button.submit").click();

  // 偽 Stripe Checkout: 拒否カードでは進めず、テストカードで支払える。
  await expect(page).toHaveURL(/\/c\/pay\/cs_test_/);
  await expect(page.getByTestId("amount")).toHaveText("¥3,000");
  await page.getByLabel("カード番号").fill(TEST_CARD_DECLINED);
  await page.getByRole("button", { name: "支払う" }).click();
  await expect(page.getByRole("alert")).toContainText("カードが拒否されました");
  await page.getByLabel("カード番号").fill(TEST_CARD_OK);
  await page.getByRole("button", { name: "支払う" }).click();

  // 完了ページ → 確認メールのチケット URL → チケットページ（QR）。
  await expect(page.getByText("お申し込みが完了しました")).toBeVisible();
  const [ticketUrl] = await ticketUrls(page);
  expect(ticketUrl).toBeTruthy();
  await page.goto(ticketUrl!, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("VALID").first()).toBeVisible();
  const qr = await page.request.get(`${ticketUrl}/qr.png`);
  expect(qr.headers()["content-type"]).toBe("image/png");

  // 当日受付（fe2 /lp/checkin）。QR の中身（= チケット URL）を手入力欄に入れる。
  await page.goto("/lp/checkin");
  await expect(page.getByTestId("fe2-lp-checkin-body")).toBeVisible();
  await expect(page.getByTestId("fe2-lp-checkin-count")).toHaveText("0");
  await checkIn(page, ticketUrl!);
  await expect(page.getByTestId("fe2-lp-checkin-result-title")).toHaveText("受付しました");
  await expect(page.getByTestId("fe2-lp-checkin-count")).toHaveText("1");

  // 同じ券をもう一度 → 受付済み（二重受付は拒否・件数は増えない）。
  await checkIn(page, ticketUrl!);
  await expect(page.getByTestId("fe2-lp-checkin-result-title")).toHaveText("受付済みです");
  await expect(page.getByTestId("fe2-lp-checkin-count")).toHaveText("1");
});

test("free: coupon -> 0 yen order (no Stripe) -> reception checks in by order number", async ({ page }) => {
  const { free } = await reset(page);
  const res = await page.request.post(`${STACK}/__e2e/coupon`, { data: { ticketTypeId: free.id, maxUses: 5 } });
  const coupon = (await res.json()) as { code: string };

  // 0 円の券種はクーポンを入れた人にだけ出る。
  await page.goto(`${STACK}/tickets`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(`select[name="qty_${free.id}"]`)).toHaveCount(0);
  await page.locator('input[name="couponCode"]').fill(coupon.code);
  await page.getByRole("button", { name: "適用" }).click();
  await page.locator(`select[name="qty_${free.id}"]`).selectOption("1");
  await page.locator('input[name="name"]').fill("北陸 花子");
  await page.locator('input[name="email"]').fill("hanako@example.com");
  await page.locator("button.submit").click();

  await expect(page).toHaveURL(/\/tickets\/thanks\?order=tko_/);
  await expect(page.getByText("お申し込みが完了しました")).toBeVisible();
  const orderRef = new URL(page.url()).searchParams.get("order")!.slice(-8);

  await page.goto("/lp/checkin");
  await checkIn(page, orderRef);
  await expect(page.getByTestId("fe2-lp-checkin-result-title")).toHaveText("受付しました");
  await checkIn(page, orderRef);
  await expect(page.getByTestId("fe2-lp-checkin-result-title")).toHaveText("受付済みです");
  await checkIn(page, "ZZZZ9999");
  await expect(page.getByTestId("fe2-lp-checkin-result-title")).toHaveText("チケットが見つかりません");
});
