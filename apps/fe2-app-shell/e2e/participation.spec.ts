// 参加届 E2E (real browser, DEMO transport / no gateway). Proves the single-source-of-truth
// design the 社長 asked for:
//   (a) the PUBLIC form at /participate (no login) accepts the two required emails and
//       shows the サンクス — this is the one form participants use;
//   (b) the in-shell /participation is the オンボーディング tab (items + team meetings + the
//       public /onboarding URL, which asks for the team first), and 回答一覧 carries the
//       public /participate URL instead;
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
  // 所属チームは名簿のチームから選ぶ (公開案内 API の teams)。
  await page.getByTestId("participation-team").selectOption("team_network");
  await page.screenshot({ path: shot("01-public-form.png"), fullPage: true });

  await page.getByTestId("participation-submit").click();
  await expect(page.getByTestId("participation-thanks")).toBeVisible();
  await page.screenshot({ path: shot("02-public-thanks.png"), fullPage: true });
});

test("(b) オンボーディング tab manages the items, team meetings and shares the public /onboarding page", async ({ page }) => {
  await page.goto("/participation");
  await expect(page.getByTestId("onboarding-admin-page")).toBeVisible();
  await expect(page.getByTestId("member-roster-subnav")).toContainText("オンボーディング");
  await expect(page.getByTestId("onboarding-share-url")).toHaveText(/\/onboarding$/);
  await expect(page.getByTestId("onboarding-admin-item-onb_demo_2")).toContainText("Slack に参加する");
  // ミーティング: 全体 + 名簿の各チーム。設定済みは日時、未設定は「未設定」。
  await expect(page.getByTestId("onboarding-meeting-all")).toContainText("10/20(火) 19:00〜20:00");
  await expect(page.getByTestId("onboarding-meeting-team_ops")).toContainText("未設定");
  await page.screenshot({ path: shot("03-onboarding-admin.png"), fullPage: true });

  await page.getByTestId("onboarding-admin-add").click();
  await page.getByTestId("onboarding-item-title").fill("自己紹介を投稿する");
  await page.getByTestId("onboarding-item-url").fill("https://slack.com/example");
  await page.getByTestId("onboarding-item-save").click();
  await expect(page.getByTestId("onboarding-admin-list")).toContainText("自己紹介を投稿する");

  await page.getByTestId("onboarding-meeting-edit-team_ops").click();
  await page.getByTestId("onboarding-meeting-schedule").fill("毎週金曜 21:00〜");
  await page.getByTestId("onboarding-meeting-url").fill("https://meet.google.com/ops-team");
  await page.screenshot({ path: shot("03a-onboarding-meeting-dialog.png") });
  await page.getByTestId("onboarding-meeting-save").click();
  await expect(page.getByTestId("onboarding-meeting-team_ops")).toContainText("毎週金曜 21:00〜");
  await expect(page.getByTestId("onboarding-meeting-team_ops")).toContainText("https://meet.google.com/ops-team");
  await page.getByTestId("onboarding-admin-meetings").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400); // let the toast / scroll settle before the shot
  await page.getByTestId("onboarding-admin-meetings").screenshot({ path: shot("03e-onboarding-admin-meetings.png") });

  // 公開ページはログイン不要。まずチームを選ぶと、やること → 全体 → チームのミーティングが並ぶ
  // （goto で demo は再 seed される）。
  await page.goto("/onboarding");
  await expect(page.getByTestId("onboarding-public-team-picker")).toBeVisible();
  await expect(page.getByTestId("onboarding-public-steps")).toHaveCount(0);
  await page.screenshot({ path: shot("03b-onboarding-public-pick.png"), fullPage: true });
  await page.getByTestId("onboarding-public-team-team_dev").click();
  const steps = page.getByTestId("onboarding-public-steps");
  await expect(steps).toContainText("参加届を出す");
  await expect(steps).toContainText("Slack の表示名を変更する");
  await expect(page.getByTestId("onboarding-public-when-all")).toHaveText("10/20(火) 19:00〜20:00");
  await expect(page.getByTestId("onboarding-public-when-team_dev")).toHaveText("毎週水曜 20:00〜");
  await expect(page.getByTestId("onboarding-public-step-team_dev").getByRole("link", { name: "参加リンクを開く" }))
    .toHaveAttribute("href", "https://meet.google.com/dev-team-mtg");
  await expect(page).toHaveURL(/\?team=team_dev$/);
  await page.screenshot({ path: shot("03b-onboarding-public.png"), fullPage: true });

  // 再読み込みしても選んだチームのまま。
  await page.reload();
  await expect(page.getByTestId("onboarding-public-picked")).toContainText("開発チーム");

  // 新メンバーはスマホで開くことが多いので狭幅でも横スクロールしないこと。
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: shot("03c-onboarding-public-narrow.png"), fullPage: true });
  await page.getByTestId("onboarding-public-change-team").click();
  await expect(page.getByTestId("onboarding-public-team-picker")).toBeVisible();
  const pickOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(pickOverflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: shot("03c2-onboarding-public-pick-narrow.png"), fullPage: true });
  await page.goto("/participation");
  await expect(page.getByTestId("onboarding-admin-item-onb_demo_1")).toBeVisible();
  await page.waitForTimeout(400); // let the app fade-in settle before the shot
  await page.screenshot({ path: shot("03d-onboarding-admin-narrow.png"), fullPage: true });
});

test("(b2) 回答一覧 shows the public 参加届 form URL", async ({ page }) => {
  await page.goto("/participation/list");
  await expect(page.getByTestId("participation-public-link-url")).toHaveText(/\/participate$/);
  await expect(page.getByTestId("participation-public-link-open")).toHaveAttribute("href", "/participate");
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
// store and drop the resolve mutation). Opens the app-launcher → members → 組織図 (subnav tab).
async function gotoMembersOrgInApp(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("fe2-app-launcher-trigger").click();
  await page.getByTestId("fe2-app-launcher-item-members").click();
  await expect(page.getByTestId("members-page")).toBeVisible();
  await page.getByTestId("member-roster-subnav-tab-org-chart").click();
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
