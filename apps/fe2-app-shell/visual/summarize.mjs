// Turns Playwright's results.json into the markdown body of the PR comment /
// job summary for the (warning-only) app-screen visual check.
//
// Usage: node summarize.mjs <results.json> <out.md> [--seeded=false] [--run-url=URL]
// Writes `changed=<n>` / `errored=<n>` to $GITHUB_OUTPUT when set.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

export const MARKER = "<!-- visual-screens-report -->";

const [, , resultsPath, outPath, ...flags] = process.argv;
const flag = (k) => flags.find((f) => f.startsWith(`--${k}=`))?.slice(k.length + 3);
const seeded = flag("seeded") !== "false";
const runUrl = flag("run-url") ?? "";

function collect(suite, acc = []) {
  for (const s of suite.suites ?? []) collect(s, acc);
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const r = t.results?.[t.results.length - 1];
      acc.push({ title: spec.title, project: t.projectName, status: r?.status ?? "skipped", error: r?.error?.message ?? "" });
    }
  }
  return acc;
}

const rows = existsSync(resultsPath) ? collect(JSON.parse(readFileSync(resultsPath, "utf8"))) : null;
// Strip ANSI + the " @mobile" tag for display.
const clean = (s) => s.replace(/\u001b\[[0-9;]*m/g, "");
const name = (t) => t.title.replace(/\s*@mobile\b/, "");

const failed = (rows ?? []).filter((r) => r.status !== "passed" && r.status !== "skipped");
const isDiff = (r) => /Screenshot comparison failed|pixels? \(ratio|different from|toHaveScreenshot/i.test(r.error);
const isMissing = (r) => /snapshot doesn't exist/i.test(r.error);
const changed = failed.filter((r) => isDiff(r) && !isMissing(r));
const missing = failed.filter(isMissing);
const errored = failed.filter((r) => !changed.includes(r) && !missing.includes(r));

const lines = [MARKER, "## 画面ビジュアル差分（fe2 app screens・警告のみ）", ""];
if (rows === null) {
  lines.push("⚠️ テスト結果（results.json）が見つかりませんでした。ビルド/起動で失敗している可能性があります。ジョブのログを確認してください。");
} else if (!seeded) {
  lines.push(
    "🌱 Linux ベースラインがまだありません。今回の実行で生成した画像を artifact `visual-screens-seed` に置きました。",
    "",
    "**Visual Screens Baselines** ワークフローを、このブランチを指定して手動実行するとコミットされます（以後の PR から比較が有効になります）。",
  );
} else if (failed.length === 0) {
  lines.push(`✅ 差分なし（${rows.length} 枚すべて一致）`);
} else {
  lines.push(`⚠️ ${changed.length} 枚に差分 / 新規 ${missing.length} / エラー ${errored.length}（全 ${rows.length} 枚）。**このチェックは PR をブロックしません。**`, "");
  lines.push("| 画面 | ビューポート | 状態 |", "| --- | --- | --- |");
  for (const r of changed) lines.push(`| ${name(r)} | ${r.project} | 差分あり |`);
  for (const r of missing) lines.push(`| ${name(r)} | ${r.project} | ベースライン無し（新規画面） |`);
  for (const r of errored) lines.push(`| ${name(r)} | ${r.project} | エラー: ${clean(r.error).split("\n")[0].slice(0, 120).replace(/\|/g, "\\|")} |`);
  lines.push(
    "",
    "- 差分画像（expected / actual / diff）は artifact **`visual-screens-diff`** の HTML レポート（`.report/index.html`）で確認できます。",
    "- 意図した変更なら **Visual Screens Baselines** ワークフローをこのブランチで実行してベースラインを更新してください。",
    "- 意図しない変更なら、それが UI リグレッションです。",
  );
}
if (runUrl) lines.push("", `[実行ログ / artifact](${runUrl})`);

writeFileSync(outPath, lines.join("\n") + "\n");
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed.length + missing.length}\nerrored=${errored.length + (rows === null ? 1 : 0)}\n`);
}
console.log(lines.join("\n"));
