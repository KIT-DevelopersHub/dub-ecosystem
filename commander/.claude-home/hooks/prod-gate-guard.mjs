#!/usr/bin/env node
// PreToolUse(Bash) guard for the Commander agent: makes the owner-only production gate
// physical instead of a prompt-level promise. The agent runs with the owner's own gh
// token, so GitHub cannot tell an agent-applied 「確認した」 from the owner's — this hook
// is where that line is drawn.
//
// Blocks (exit 2 = the command is not run, stderr goes back to the agent):
//   - adding/renaming/creating the 「確認した」 label in any form
//   - `gh pr merge` into main unless the PR already carries 「確認した」 (applied by the
//     owner) or is Commander-only (scripts/commander-only-pr.sh); `--admin` always
//   - pushing to main, dispatching the prod deploy workflow, local prod deploys
//
// Fail-close: if the PR cannot be inspected, the merge is blocked.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "確認した";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMMANDER_ONLY = join(REPO_ROOT, "scripts", "commander-only-pr.sh");

const HOW =
  `「${LABEL}」はオーナーだけが付けるラベルです。自分で付けず、最終報告に ` +
  "`これに付けて: <PR URL>` を1行書いて止まってください。";

function block(reason) {
  process.stderr.write(`[prod-gate-guard] ブロックしました: ${reason}\n`);
  process.exit(2);
}

/** Split a shell line into simple commands (good enough for agent-written commands). */
function segments(cmd) {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function checkMerge(seg) {
  if (/\s--admin\b/.test(seg)) block("`gh pr merge --admin` は必須チェックを迂回するため禁止です。");
  const tokens = seg.slice(seg.search(/gh\s+pr\s+merge/)).split(/\s+/).slice(3);
  const repoIdx = tokens.findIndex((t) => t === "--repo" || t === "-R");
  const repo = repoIdx >= 0 ? tokens[repoIdx + 1] : undefined;
  const target = tokens.find((t, i) => !t.startsWith("-") && (repoIdx < 0 || i !== repoIdx + 1));
  const repoArgs = repo ? ["--repo", repo] : [];
  let pr;
  try {
    pr = JSON.parse(
      gh(["pr", "view", ...(target ? [target] : []), ...repoArgs, "--json", "number,baseRefName,labels"]),
    );
  } catch {
    block("マージ対象の PR を確認できませんでした (fail-close)。PR 番号を明示してください。");
  }
  if (pr.baseRefName !== "main") return; // integration/stacked branches: no prod effect
  if (pr.labels.some((l) => l.name === LABEL)) return; // owner already confirmed
  if (existsSync(COMMANDER_ONLY)) {
    try {
      execFileSync("bash", [COMMANDER_ONLY, String(pr.number), ...repoArgs], { stdio: "ignore" });
      return; // Commander-only: ships straight to prod by owner decision
    } catch {
      /* not commander-only */
    }
  }
  block(`PR #${pr.number} に「${LABEL}」が無いため main (=本番) にマージできません。${HOW}`);
}

function checkSegment(seg) {
  // Match gh anywhere (env prefixes, `bash -c "gh ..."`), not only at the start.
  const isGh = /(^|[\s"'(])gh\s/.test(seg);

  // 1) The label itself: never apply / create / rename it.
  if (isGh && seg.includes(LABEL)) {
    if (/\s--add-label\b/.test(seg)) block(HOW);
    if (/\bgh\s+label\s/.test(seg)) block(`「${LABEL}」ラベルの作成・変更はできません。`);
    if (/\bgh\s+api\s/.test(seg) && /(\s-[fF]\s|--field|--raw-field|--input|-X\s*(POST|PUT|PATCH)|--method\s+(POST|PUT|PATCH))/i.test(seg)) {
      block(HOW);
    }
  }
  if (/addLabelsToLabelable|LA_kwDOTzKL6s8AAAACxIbecw/.test(seg)) {
    block("GraphQL でのラベル付与は禁止です (staging 枠ラベルは `gh pr edit --add-label` で付ける)。");
  }

  // 2) Merging into main.
  if (/(^|[\s"'(])gh\s+pr\s+merge\b/.test(seg)) checkMerge(seg);

  // 3) Other routes to prod that skip the label gate.
  if (/(^|[\s"'(])git\s+push\b/.test(seg)) {
    const refs = seg.slice(seg.search(/git\s+push/)).split(/\s+/).slice(2).map((t) => t.replace(/["')]+$/, "")).filter((t) => !t.startsWith("-"));
    if (refs.some((r) => r === "main" || /(^|:)(refs\/heads\/)?main$/.test(r))) {
      block("main への直接 push は禁止です (PR 経由でのみ main に入れる)。");
    }
  }
  if (/\bgh\s+workflow\s+run\b/.test(seg) && /deploy\.yml|Deploy \(production\)|\bdeploy\b/i.test(seg)) {
    block("本番デプロイ workflow の手動起動はラベルゲートを迂回するため禁止です。");
  }
  if (/\bgh\s+api\s/.test(seg) && /deploy\.yml\/dispatches/.test(seg)) {
    block("本番デプロイ workflow の手動起動はラベルゲートを迂回するため禁止です。");
  }
  if (/deploy-prod\.sh|ship:prod|^pnpm\s+deploy(\s|$)/.test(seg)) {
    block("手元からの本番デプロイは禁止です (本番は main マージで deploy.yml が自動で行う)。");
  }
  if (/\bwrangler\s+(versions\s+)?deploy\b/.test(seg) && !/demo|staging/.test(seg)) {
    block("手元からの本番 `wrangler deploy` は禁止です (本番は main マージで deploy.yml が自動で行う)。");
  }
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
if (input.tool_name !== "Bash") process.exit(0);
const cmd = String(input.tool_input?.command ?? "");
for (const seg of segments(cmd)) checkSegment(seg);
process.exit(0);
