#!/usr/bin/env node
// P15: a11y横断 — icon-only な <button> は aria-label (or aria-labelledby) を持つことを
// リポジトリ全体で強制する静的チェック。ESLint 未導入のリポジトリのため、
// 既存の @dub/ui IconButtonProps の型レベル必須化 (aria-label: string) を補完する
// ランタイム非依存の軽量 lint として動く。CI: `pnpm run lint:a11y`。
//
// 検出対象: <button> の子要素がアイコン(<Icon .../>, <svg>...)のみで、可視テキストも
// aria-label/aria-labelledby も無いもの。ただし button 自体が aria-hidden="true" の場合は
// (ロービングタブストップの重複デコイなど、意図的に AT から除外された要素) 除外する。
//
// 実装メモ: 属性値/イベントハンドラの `=>`（アロー関数）は `>` を含むため単純な
// 正規表現 `<button.*?>` ではタグの境界を誤検出する。ここでは文字を辿り、
// 文字列/テンプレートリテラル/`{}()[]` の深さを追跡して本当のタグ終端 `>` を探す。

import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  "__screenshots__",
  ".worktrees",
]);

function collectTsxFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (IGNORE_DIRS.has(entry)) continue;
      collectTsxFiles(full, out);
    } else if (
      entry.endsWith(".tsx") &&
      !entry.endsWith(".test.tsx") &&
      !full.includes(`${path.sep}test${path.sep}`) &&
      !full.includes(`${path.sep}stories${path.sep}`)
    ) {
      out.push(full);
    }
  }
  return out;
}

// Find the index right after the opening tag's terminating '>' (or the index of the
// self-closing '/>' start), tracking bracket/quote depth so JSX expression braces and
// arrow-function `=>` don't get mistaken for the tag boundary.
function findTagEnd(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") {
      depth++;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth--;
      continue;
    }
    if (depth === 0 && c === "/" && src[i + 1] === ">") {
      return { end: i + 2, selfClosing: true };
    }
    if (depth === 0 && c === ">" && src[i - 1] !== "=") {
      return { end: i + 1, selfClosing: false };
    }
  }
  return null;
}

function findMatchingClose(src, from) {
  let depth = 1;
  let i = from;
  while (i < src.length) {
    if (src.startsWith("<button", i) && /[\s/>]/.test(src[i + 7] ?? ">")) {
      depth++;
      i += 7;
      continue;
    }
    if (src.startsWith("</button>", i)) {
      depth--;
      if (depth === 0) return i;
      i += 9;
      continue;
    }
    i++;
  }
  return -1;
}

const ICON_TAG_RE = /<(svg|Icon|[A-Za-z]*Icon)\b[\s\S]*?(?:\/>|<\/\1>)/g;
const HIDDEN_WRAPPER_RE = /<span[^>]*aria-hidden[\s\S]*?<\/span>/g;

function isIconOnlyNoLabel(attrs, body) {
  if (/aria-label|aria-labelledby/.test(attrs)) return false;
  if (/aria-hidden\s*=\s*["'{]?true/.test(attrs)) return false; // intentionally excluded from a11y tree

  let residual = body.replace(ICON_TAG_RE, "").replace(HIDDEN_WRAPPER_RE, "");
  residual = residual.replace(/<[^>]+>/g, " "); // strip remaining tag markup, keep text/expr content
  residual = residual.replace(/\s+/g, " ").trim();
  return residual.length === 0;
}

function scanFile(fp) {
  const src = readFileSync(fp, "utf-8");
  const violations = [];
  const re = /<button\b/g;
  let m;
  while ((m = re.exec(src))) {
    const tagEnd = findTagEnd(src, m.index + 7);
    if (!tagEnd) continue;
    const attrsEnd = tagEnd.selfClosing ? tagEnd.end - 2 : tagEnd.end - 1;
    const attrs = src.slice(m.index + 7, attrsEnd);
    let body = "";
    if (!tagEnd.selfClosing) {
      const closeIdx = findMatchingClose(src, tagEnd.end);
      if (closeIdx === -1) continue;
      body = src.slice(tagEnd.end, closeIdx);
    }
    const hasIcon = /<svg|<Icon\b|<[A-Za-z]*Icon\b/.test(attrs + body);
    if (!hasIcon) continue;
    if (isIconOnlyNoLabel(attrs, body)) {
      const line = src.slice(0, m.index).split("\n").length;
      violations.push({ file: path.relative(repoRoot, fp), line });
    }
  }
  return violations;
}

const files = [
  ...collectTsxFiles(path.join(repoRoot, "apps")),
  ...collectTsxFiles(path.join(repoRoot, "packages")),
];

let violations = [];
for (const f of files) {
  violations = violations.concat(scanFile(f));
}

if (violations.length > 0) {
  console.error(
    `\n[lint:a11y] icon-only <button> は aria-label (または aria-labelledby) が必須です。` +
      ` ${violations.length} 件の違反:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
  }
  console.error(
    `\n修正方法: aria-label="<機能に即した日本語ラベル>" を追加するか、` +
      ` @dub/ui の <IconButton aria-label="..."> を使ってください。\n`,
  );
  process.exit(1);
}

console.log(`[lint:a11y] OK — icon-only <button> ${files.length} ファイルをスキャン、違反なし。`);
