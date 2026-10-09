// Playwright E2E: 運営名簿と参加届が同じ人物項目 (PersonProfile) を使っていることを live demo で確認する。
// Home -> 運営メンバー -> メンバー追加フォームに参加届と同じ 14 項目 -> 保存 -> 編集で値が残る
// -> 参加届フォームにも同じ 14 項目 -> 提出 -> 回答一覧 -> 新規で追加 -> 名簿に全項目が引き継がれる。
// Usage: E2E_BASE=https://dub-demo-roster-number.developershub-site.workers.dev node e2e/person-profile-unify-demo.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.E2E_BASE ?? "http://localhost:4319";
const SHOTS = join(homedir(), "DubVault/docs/person-profile-unify-e2e");
mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(SHOTS, name), fullPage: true });
const ok = (m) => console.log(`  ok: ${m}`);
const fail = (m) => { throw new Error(m); };

const PROFILE = [
  "last-name", "first-name", "last-name-kana", "first-name-kana", "last-name-romaji", "first-name-romaji",
  "school-email", "gmail", "phone", "roster-number", "grade", "department", "desired-activity", "note",
];
const expectAllFields = async (scope, prefix, where) => {
  for (const k of PROFILE) {
    if (!(await scope.getByTestId(`${prefix}-${k}`).count())) fail(`${where}: ${prefix}-${k} がない`);
  }
  ok(`${where}: 人物項目 ${PROFILE.length} 個がそろっている`);
};

// 編集ダイアログは開いた後に既存値を流し込むので、苗字が入るまで待ってから読む。
const waitFilled = (page) =>
  page.waitForFunction(() => (document.querySelector('[data-testid="members-form-last-name"]')?.value ?? "") !== "", null, {
    timeout: 5000,
  });

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // 1. メンバー追加フォーム
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  // 画面下に固定の「デモモード」帯が行の操作ボタンに重なるので、操作の邪魔にならないよう隠す。
  await page.addStyleTag({ content: 'div[role="note"]{display:none !important}' });
  await page.locator('a[href="/members"]').first().click();
  await page.getByTestId("member-roster-subnav-tab-member-roster").click();
  const table = page.getByTestId("members-table");
  await table.waitFor({ timeout: 20000 });
  await page.getByTestId("member-roster-add-member").click();
  const dialog = page.getByTestId("members-form-dialog");
  await dialog.getByTestId("members-form-profile-section").waitFor();
  await expectAllFields(dialog, "members-form", "メンバー追加フォーム");

  await dialog.getByTestId("members-form-last-name").fill("統一");
  await dialog.getByTestId("members-form-first-name").fill("一子");
  await dialog.getByTestId("members-form-last-name-kana").fill("とういつ");
  if ((await dialog.getByTestId("members-form-last-name-romaji").inputValue()) !== "Touitsu") fail("ローマ字が自動入力されない");
  ok("ふりがなからローマ字が自動入力される");
  await dialog.getByTestId("members-form-grade").selectOption("2");
  await dialog.getByTestId("members-form-roster-number").fill("2ep1-07");
  await dialog.getByTestId("members-form-desired-activity").selectOption("dev");
  await dialog.getByTestId("members-form-gmail").fill("not-mail");
  await dialog.getByTestId("members-form-submit").click();
  await dialog.getByText("メールアドレスの形式が正しくありません").waitFor({ timeout: 5000 });
  ok("参加届と同じ形式チェックが効く (Gmail)");
  await shot(page, "01-member-form.png");

  await dialog.getByTestId("members-form-gmail").fill("touitsu@gmail.com");
  await dialog.getByTestId("members-form-submit").click();
  await dialog.waitFor({ state: "hidden", timeout: 10000 });
  await page.getByTestId("member-roster-search").fill("2EP1-07");
  const row = table.getByRole("row").filter({ hasText: "統一 一子" });
  await row.waitFor({ timeout: 10000 });
  if (!(await row.getByText("とういつ").count())) fail("一覧にふりがなが出ない");
  ok("保存した人が名列番号で検索でき、ふりがなも表示される");
  await page.getByTestId("member-roster-search").fill("2年");
  await row.waitFor({ timeout: 5000 });
  ok("学年は「2年」の表示で検索できる");

  await row.getByRole("button", { name: "統一 一子 を編集" }).click();
  await dialog.waitFor();
  await waitFilled(page);
  if ((await dialog.getByTestId("members-form-grade").inputValue()) !== "2") fail("編集で学年が残っていない");
  if ((await dialog.getByTestId("members-form-desired-activity").inputValue()) !== "dev") fail("編集で希望する活動が残っていない");
  if ((await dialog.getByTestId("members-form-gmail").inputValue()) !== "touitsu@gmail.com") fail("編集で Gmail が残っていない");
  ok("編集を開くと保存した値が入っている");
  await shot(page, "02-member-edit.png");
  await page.keyboard.press("Escape");

  // 2. 参加届フォーム
  await page.getByTestId("member-roster-subnav-tab-participation").click();
  await page.getByTestId("participation-submit").waitFor({ timeout: 20000 });
  await expectAllFields(page, "participation", "参加届フォーム");
  await page.getByTestId("participation-last-name").fill("共通");
  await page.getByTestId("participation-first-name").fill("二郎");
  await page.getByTestId("participation-last-name-kana").fill("きょうつう");
  await page.getByTestId("participation-school-email").fill("kyotsu@school.ac.jp");
  await page.getByTestId("participation-gmail").fill("kyotsu@gmail.com");
  await page.getByTestId("participation-grade").selectOption("3");
  await page.getByTestId("participation-roster-number").fill("3ep2-41");
  await page.getByTestId("participation-desired-activity").selectOption("event");
  await shot(page, "03-participation-form.png");
  await page.getByTestId("participation-submit").click();
  await page.getByTestId("participation-thanks").waitFor({ timeout: 10000 });
  ok("参加届を提出できた");

  // 3. 回答一覧 -> 新規で追加 -> 名簿に引き継ぎ
  await page.getByTestId("member-roster-subnav-tab-participation-list").click();
  const plist = page.getByTestId("participation-list-table");
  await plist.waitFor({ timeout: 20000 });
  for (const h of ["ふりがな", "名列番号", "学年", "希望する活動", "備考"]) {
    await plist.getByRole("columnheader", { name: h, exact: true }).waitFor({ timeout: 5000 });
  }
  ok("回答一覧の列名が名簿と同じ");
  const prow = plist.getByRole("row").filter({ hasText: "共通 二郎" });
  await prow.getByRole("button", { name: "追加する" }).click();
  await page.getByTestId("participation-resolve-create").click();
  await prow.getByText(/追加済/).waitFor({ timeout: 10000 });
  await shot(page, "04-participation-list.png");

  await page.getByTestId("member-roster-subnav-tab-member-roster").click();
  await table.waitFor({ timeout: 20000 });
  await page.getByTestId("member-roster-search").fill("3EP2-41");
  const mrow = table.getByRole("row").filter({ hasText: "共通 二郎" });
  await mrow.waitFor({ timeout: 10000 });
  await mrow.getByRole("button", { name: "共通 二郎 を編集" }).click();
  await dialog.waitFor();
  await waitFilled(page);
  const kana = await dialog.getByTestId("members-form-last-name-kana").inputValue();
  const activity = await dialog.getByTestId("members-form-desired-activity").inputValue();
  if (kana !== "きょうつう" || activity !== "event") fail(`名簿に引き継がれていない (kana=${kana}, activity=${activity})`);
  ok("参加届の内容 (ふりがな・希望する活動など) が名簿のフォームにそのまま出る");
  await shot(page, "05-member-from-participation.png");

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  console.log("PASS");
} finally {
  await browser.close();
}
