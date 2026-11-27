// 総点検（#852）の共通処理: 入室・スクショ・画面の健康チェック。
import { expect, test as base, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 立っている環境（staging など）を見ている時は true。書き込み系の手順は飛ばす。 */
export const REMOTE = Boolean(process.env.SMOKE_BASE_URL);
export const CAN_WRITE = !REMOTE;
export const PUBLIC_LP_URL = process.env.SMOKE_PUBLIC_LP_URL ?? "";

const SHOTS = process.env.SMOKE_SHOTS ?? join(HERE, "..", ".output", "smoke-all-shots");
mkdirSync(SHOTS, { recursive: true });

type Fixtures = { shot: (name: string) => Promise<void>; health: { failures: string[] } };

export const test = base.extend<Fixtures>({
  // ページの例外と 5xx・429 を集め、テストの最後にまとめて落とす。
  health: [
    async ({ page }, use) => {
      const failures: string[] = [];
      page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));
      page.on("response", (r) => {
        const s = r.status();
        if (s >= 500 || s === 429) failures.push(`${s} ${new URL(r.url()).pathname}`);
      });
      await use({ failures });
      expect(failures, "画面の例外・サーバーエラー・レート制限").toEqual([]);
    },
    { auto: true },
  ],
  shot: async ({ page }, use, info) => {
    await use(async (name) => {
      await page.screenshot({ path: join(SHOTS, `${info.project.name}-${name}.png`), fullPage: true });
    });
  },
});
export { expect };

/** path を開く。ログイン画面が出たら「デモ管理者で入る」で入ってから開き直す。 */
export async function enter(page: Page, path: string): Promise<void> {
  const demo = page.getByTestId("fe2-login-demo");
  const shell = page.getByTestId("fe2-shell");
  await page.goto(path);
  // 認証の確認が終わるまでは殻が一瞬出てからログイン画面へ移ることがある。
  await page.waitForLoadState("networkidle");
  await expect(demo.or(shell).first()).toBeVisible();
  if (await demo.isVisible()) {
    await demo.click();
    await expect(shell).toBeVisible();
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  await expect(shell).toBeVisible();
  await expect(demo).toHaveCount(0);
}

/** 画面全体のエラー表示が出ていないこと。 */
export async function expectNoErrorScreen(page: Page): Promise<void> {
  await expect(page.getByTestId("fe2-error-fallback")).toHaveCount(0);
  await expect(page.getByTestId("fe2-load-error")).toHaveCount(0);
}
