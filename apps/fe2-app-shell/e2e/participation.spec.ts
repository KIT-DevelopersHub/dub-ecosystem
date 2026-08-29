// 参加届 E2E (real browser, DEMO transport / no gateway). Proves the single-source-of-truth
// design the 社長 asked for:
//   (a) the PUBLIC form at /participate (no login) accepts the two required emails and
//       shows the サンクス — this is the one form participants use;
//   (b) the in-shell /participation renders the SAME form component and links out to the
//       public /participate URL (運営 share that link, no second form to maintain);
//   (c) the 運営専用 回答一覧 at /participation/list shows submitted 参加届 (氏名 / 学校メール /
//       Gmail / 所属 / 希望) and opens a detail drawer on row click.
// The list is seeded with two submitted records so it has content on first load; a real
// submit also pushes onto the same in-memory store.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = process.env.PARTICIPATION_SHOTS ?? "/Users/kota/DubVault/docs/form-romaji";
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string): string => `${SHOTS}/${name}`;

test("(a) public /participate accepts split 姓/名 + emails + phone and confirms", async ({ page }) => {
  await page.goto("/participate");
  await expect(page.getByTestId("participation-public-page")).toBeVisible();

  // 新レイアウト: 氏名[姓/名] → 振り仮名[せい/めい] → メール → 電話
  await page.getByTestId("participation-last-name").fill("公開");
  await page.getByTestId("participation-first-name").fill("太郎");
  await page.getByTestId("participation-last-name-kana").fill("こうかい");
  await page.getByTestId("participation-first-name-kana").fill("たろう");
  // ローマ字はふりがなから自動プリフィルされる (メール発行用). 値が入っていることを確認。
  await expect(page.getByTestId("participation-last-name-romaji")).toHaveValue("Koukai");
  await expect(page.getByTestId("participation-first-name-romaji")).toHaveValue("Tarou");
  await page.getByTestId("participation-school-email").fill("koukai@school.ac.jp");
  await page.getByTestId("participation-gmail").fill("koukai.taro@gmail.com");
  await page.getByTestId("participation-phone").fill("090-1234-5678");
  // 希望チーム(参加したい班) / 希望する活動 は実際には選べないため削除済み: 存在しないこと。
  await expect(page.getByTestId("participation-team")).toHaveCount(0);
  await expect(page.getByTestId("participation-activity")).toHaveCount(0);
  await expect(page.getByText("参加したい班を選べます")).toHaveCount(0);
  await expect(page.getByText("希望する活動")).toHaveCount(0);
  await page.screenshot({ path: shot("01-public-form.png"), fullPage: true });

  await page.getByTestId("participation-submit").click();
  await expect(page.getByTestId("participation-thanks")).toBeVisible();
  await page.screenshot({ path: shot("02-public-thanks.png"), fullPage: true });
});

test("(b) in-shell /participation reuses the same form and links to the public URL", async ({ page }) => {
  await page.goto("/participation");
  await expect(page.getByTestId("participation-page")).toBeVisible();
  // Same form component (両メール必須) as the public page.
  await expect(page.getByTestId("participation-school-email")).toBeVisible();
  await expect(page.getByTestId("participation-gmail")).toBeVisible();
  // 導線: link out to the public /participate form (no second implementation).
  const link = page.getByTestId("participation-public-link").locator("a");
  await expect(link).toHaveAttribute("href", "/participate");
  await page.screenshot({ path: shot("03-inshell-form-with-link.png"), fullPage: true });
});

test("(c) 運営 回答一覧 lists submitted 参加届 and opens a detail drawer", async ({ page }) => {
  await page.goto("/participation/list");
  await expect(page.getByTestId("participation-list-page")).toBeVisible();
  await expect(page.getByTestId("participation-list-table")).toBeVisible();

  // Seeded submissions show 氏名 + 学校メール + Gmail.
  await expect(page.getByText("kurokawa@school.ac.jp")).toBeVisible();
  await expect(page.getByText("tanaka.minoru@gmail.com")).toBeVisible();
  await page.screenshot({ path: shot("04-list.png"), fullPage: true });

  // Row click → detail drawer with the full record.
  await page.getByText("田中 実").click();
  const detail = page.getByTestId("participation-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByText("tanaka@school.ac.jp")).toBeVisible();
  await expect(detail.getByText("電気電子工学科")).toBeVisible();
  // ローマ字氏名 + アルファベットのメール素案が表示される (メール発行用).
  await expect(detail.getByText("Tanaka Minoru")).toBeVisible();
  await expect(detail.getByText("minoru.tanaka@…")).toBeVisible();
  await page.waitForTimeout(500); // let the drawer slide-in settle before the shot
  await page.screenshot({ path: shot("05-detail.png"), fullPage: true });
});

// SPA in-app navigation to the 組織図 (full page.goto would re-seed the in-memory demo
// store and drop the resolve mutation). Opens the app-launcher → members → 組織図 tab.
async function gotoMembersOrgInApp(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("fe2-app-launcher-trigger").click();
  await page.getByTestId("fe2-app-launcher-item-members").click();
  await expect(page.getByTestId("members-page")).toBeVisible();
  await page.getByTestId("members-tabs-tab-org").click();
  await expect(page.getByTestId("members-orgchart")).toBeVisible();
}

test("(d) 追加する: 招待中候補なし → 新規で追加 (create) し組織図に新ノードが出る", async ({ page }) => {
  await page.goto("/participation/list");
  await expect(page.getByTestId("participation-list-table")).toBeVisible();
  // seed_2「田中 実」は未処理・招待中に該当なし。
  await expect(page.getByTestId("participation-reviewstate-part_seed_2")).toHaveText(/未処理/);
  await page.getByTestId("participation-add-part_seed_2").click();
  // 候補なしダイアログ (新規追加の確認)。
  await expect(page.getByTestId("participation-resolve-dialog")).toBeVisible();
  await expect(page.getByTestId("participation-resolve-new")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot("06-resolve-new-dialog.png"), fullPage: true });
  await page.getByTestId("participation-resolve-create").click();
  // 反映後は「追加済（新規追加）」。
  await expect(page.getByTestId("participation-reviewstate-part_seed_2")).toHaveText(/追加済/);
  await page.screenshot({ path: shot("07-after-create.png"), fullPage: true });

  // 組織図に「田中 実」が新ノードとして重複なく1つ出る (SPA遷移で反映を保持)。
  await gotoMembersOrgInApp(page);
  await expect(page.getByTestId("members-orgchart").getByText("田中 実")).toHaveCount(1);
  await page.screenshot({ path: shot("08-orgchart-created.png"), fullPage: true });
});

test("(e) 追加する: 招待中候補あり → 同一人物で結合 (link) し組織図に重複なく昇格する", async ({ page }) => {
  await page.goto("/participation/list");
  await expect(page.getByTestId("participation-list-table")).toBeVisible();
  // seed_3「田村 未」は未処理・招待中 member_6 と氏名一致。
  await page.getByTestId("participation-add-part_seed_3").click();
  await expect(page.getByTestId("participation-resolve-dialog")).toBeVisible();
  // 候補一覧に招待中の田村が出る。
  await expect(page.getByTestId("participation-candidates")).toBeVisible();
  await expect(page.getByTestId("participation-link-member_6")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot("09-resolve-candidate-dialog.png"), fullPage: true });
  await page.getByTestId("participation-link-member_6").click();
  await expect(page.getByTestId("participation-reviewstate-part_seed_3")).toHaveText(/追加済/);

  // 昇格後の組織図: 「田村 未」は依然1つ (重複なし) で、打診中バッジが消える (SPA遷移)。
  await gotoMembersOrgInApp(page);
  await expect(page.getByTestId("members-orgchart").getByText("田村 未")).toHaveCount(1);
  await expect(page.getByTestId("members-orgchip-member_6")).not.toContainText("打診中");
  await page.screenshot({ path: shot("10-orgchart-linked.png"), fullPage: true });
});

test("(f) しない: 対象外 (skip) を確定すると名簿へ反映されない", async ({ page }) => {
  await page.goto("/participation/list");
  await expect(page.getByTestId("participation-list-table")).toBeVisible();
  await page.getByTestId("participation-skip-part_seed_2").click();
  const confirm = page.getByTestId("participation-skip-confirm");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "対象外にする" }).click();
  await expect(page.getByTestId("participation-reviewstate-part_seed_2")).toHaveText(/対象外/);
  await page.screenshot({ path: shot("11-after-skip.png"), fullPage: true });
});

test("(g) 追加する: 自動候補なし → 名簿から手動検索 → 招待中の別表記(漢字違い)に link し組織図で昇格", async ({ page }) => {
  await page.goto("/participation/list");
  await expect(page.getByTestId("participation-list-table")).toBeVisible();
  // seed_4「鈴木 一朗」は招待中「鈴木 一郎」(member_3) の漢字違い → 自動一致に出ない。
  await page.getByTestId("participation-add-part_seed_4").click();
  await expect(page.getByTestId("participation-resolve-dialog")).toBeVisible();
  // 候補なし3択 → 名簿から手動で紐付け。
  await expect(page.getByTestId("participation-resolve-new")).toBeVisible();
  await page.getByTestId("participation-resolve-manual").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot("12-manual-search.png"), fullPage: true });
  // 氏名で検索 → 招待中「鈴木 一郎」を選ぶ。
  await page.getByTestId("participation-manual-search").fill("鈴木");
  await expect(page.getByTestId("participation-manual-link-member_3")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot("13-manual-results.png"), fullPage: true });
  await page.getByTestId("participation-manual-link-member_3").click();
  await expect(page.getByTestId("participation-reviewstate-part_seed_4")).toHaveText(/追加済/);

  // 組織図: 「鈴木 一郎」が重複なく在籍へ昇格 (打診中バッジ消滅)。
  await gotoMembersOrgInApp(page);
  await expect(page.getByTestId("members-orgchart").getByText("鈴木 一郎")).toHaveCount(1);
  await expect(page.getByTestId("members-orgchip-member_3")).not.toContainText("打診中");
  await page.screenshot({ path: shot("14-orgchart-manual-linked.png"), fullPage: true });
});
