// Deploy-notification COPY: turn a developer-facing change title (a merged PR title or a
// raw commit subject) into user-friendly Japanese notification copy.
//
// WHY: the CI auto-notify + backfill (adminNotify.ts) used to pipe the raw PR title /
// commit subject straight into the notification title AND body. That surfaces
// conventional-commit prefixes ("fix(db):", "feat:", "chore(deps):"), backticks, English
// jargon and PR numbers to the reader — e.g.
//   fix(db): don't mis-parse `DO UPDATE SET` "SET" as a table in the namespace guard (#224)
// which is meaningless to a non-developer. This module is the single formatting seam: it
// classifies the change (新機能 / 改善 / 修正 / 更新) and produces a readable headline, so a
// raw developer string never lands verbatim in a notification.
//
// SCOPE (deliberately not full translation): full natural-language rewriting of an English
// commit line is out of reach here. The contract is weaker but guaranteed: strip the
// machine prefix + code noise, tag the change kind, and — when the cleaned text is not
// human-presentable (e.g. still pure English/dev shorthand) — fall back to a generic
// per-kind phrase. Either way the reader sees "何が良くなったか", never the raw dev string.
//
// Pure + deterministic (no clocks, no locale libs) so adminNotify.ts stays idempotent.

export type DeployChangeKind = "feature" | "improvement" | "fix" | "update";

/** Japanese genre label shown to the reader (種別). */
export const KIND_LABEL: Record<DeployChangeKind, string> = {
  feature: "新機能",
  improvement: "改善",
  fix: "修正",
  update: "更新",
};

/** Small genre glyph, matching the release-note 🎉 convention in the inbox. */
export const KIND_EMOJI: Record<DeployChangeKind, string> = {
  feature: "🎉",
  improvement: "✨",
  fix: "🔧",
  update: "🔄",
};

/** Generic headline used when the cleaned summary is not human-presentable (pure English /
 *  dev shorthand). Says "何が良くなったか" without leaking the raw string. */
const GENERIC_HEADLINE: Record<DeployChangeKind, string> = {
  feature: "新しい機能が追加されました",
  improvement: "使いやすさを改善しました",
  fix: "不具合を修正しました",
  update: "アプリを更新しました",
};

// conventional-commit type -> our reader-facing kind.
const TYPE_TO_KIND: Record<string, DeployChangeKind> = {
  feat: "feature",
  feature: "feature",
  fix: "fix",
  bugfix: "fix",
  hotfix: "fix",
  revert: "fix",
  perf: "improvement",
  refactor: "improvement",
  improve: "improvement",
  style: "improvement",
  docs: "update",
  chore: "update",
  build: "update",
  ci: "update",
  test: "update",
  deps: "update",
};

// A leading "type(scope)!: " conventional-commit prefix. scope + "!" (breaking) optional.
const CONVENTIONAL_PREFIX = /^\s*([a-zA-Z]+)(?:\([^)]*\))?!?:\s*/;
// Trailing PR/issue reference like " (#224)" — carried separately as prNumber, so it is
// noise in the headline.
const TRAILING_REF = /\s*[（(]#\d+[)）]\s*$/;
// Any Japanese character (Hiragana / Katakana / CJK / half-width kana) — used to decide
// whether the cleaned summary is presentable to a Japanese reader as-is.
const JAPANESE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;
// Leading emoji/pictographs (release titles sometimes start with 🎉) — trimmed from the
// summary so we control the glyph ourselves.
const LEADING_EMOJI = /^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️‍]+\s*/u;

export interface HumanizedChange {
  kind: DeployChangeKind;
  /** Japanese genre label (新機能 / 改善 / 修正 / 更新). */
  label: string;
  /** Reader-facing one-line summary of what changed. */
  headline: string;
  /** True when we fell back to a generic phrase (summary was not presentable). */
  generic: boolean;
  /** The cleaned (prefix/noise stripped) source text, for traceability. */
  cleaned: string;
  /** The detected conventional-commit type ("feat"/"fix"/"docs"/...) or undefined when the
   *  title had no recognizable prefix. Callers use it to skip user-irrelevant deploys. */
  type?: string;
}

/**
 * Conventional-commit types whose changes are invisible to end users (docs, tooling, deps).
 * A deploy whose ONLY signal is one of these — and which carries no human-written notify
 * line — is skipped (no Admin notification), so the inbox is not polluted with "アプリを更新
 * しました" rows that say nothing. A human notify line always overrides this (opt-in notify).
 */
export const USER_IRRELEVANT_TYPES: ReadonlySet<string> = new Set([
  "docs",
  "chore",
  "build",
  "ci",
  "test",
  "style",
  "deps",
]);

/** Detect the leading conventional-commit type of a title (lowercased), or undefined. */
export function detectConventionalType(title: string | undefined | null): string | undefined {
  const m = (title ?? "").trim().match(CONVENTIONAL_PREFIX);
  return m?.[1]?.toLowerCase();
}

/** Strip code/markdown noise from a change title so it reads as prose. */
function stripNoise(text: string): string {
  return text
    .replace(TRAILING_REF, "") // drop trailing "(#123)"
    .replace(/`+/g, "") // drop backticks (`DO UPDATE SET` -> DO UPDATE SET)
    .replace(LEADING_EMOJI, "") // drop leading decorative emoji (we add our own)
    .replace(/\s+/g, " ") // collapse whitespace/newlines
    .trim();
}

/**
 * Humanize a developer change title into reader-facing copy.
 *
 * - Detects the conventional-commit type ("feat:", "fix(db):", ...) → genre kind.
 * - Strips the machine prefix, trailing "(#NN)", backticks and decorative emoji.
 * - If the cleaned summary contains Japanese it is used as the headline; otherwise a
 *   generic per-kind phrase is used, so a raw English/dev string never shows verbatim.
 */
export function humanizeChange(rawTitle: string | undefined | null): HumanizedChange {
  const raw = (rawTitle ?? "").trim();

  const m = raw.match(CONVENTIONAL_PREFIX);
  const type = m?.[1]?.toLowerCase();
  // No conventional prefix → treat as a plain "update" (still humanized below).
  const kind: DeployChangeKind = (type && TYPE_TO_KIND[type]) || "update";

  const body = m ? raw.slice(m[0].length) : raw;
  const cleaned = stripNoise(body);

  // Presentable when there is real Japanese content to show (not just an English clause).
  const presentable = cleaned.length > 0 && JAPANESE.test(cleaned);
  const headline = presentable ? cleaned : GENERIC_HEADLINE[kind];

  return { kind, label: KIND_LABEL[kind], headline, generic: !presentable, cleaned, ...(type ? { type } : {}) };
}

// ---- human-written notify line (PR body 1st line) --------------------------------------
// The forward CI step + backfill prefer a HUMAN-written one-line notification copy over any
// machine humanization of the commit title. That line lives in the PR body (see
// .github/PULL_REQUEST_TEMPLATE.md): the author writes "何ができるようになったか" for the
// reader, and CI surfaces it verbatim. This is the only reliable way to say what actually
// became usable — CI cannot infer intent from a diff.

// Placeholder / guidance fragments that mean "the author left the field blank". Treated as
// no notify line (→ fall back to humanization). Matched case-insensitively on the trimmed line.
const NOTIFY_PLACEHOLDER = /^[（(]?\s*(例[:：]|ここに|todo\b|なし$|n\/?a$)|^<!--|^[-–—]+$/i;
// A PR-body heading whose section holds the notify line (## 通知文言 …).
const NOTIFY_HEADING = /通知文言/;
// Markdown heading / HTML comment / quote / list-bullet lines are template scaffolding, not
// the notify copy.
const SCAFFOLD_LINE = /^\s*(#{1,6}\s|<!--|-->|>|[-*]\s|---\s*$)/;

/**
 * A notify line is presentable when, after noise-stripping, it has real Japanese content and
 * is not a template placeholder. English/dev shorthand is rejected so a raw string never
 * shows verbatim (same bar as humanizeChange's `presentable`).
 */
export function isPresentableNotifyLine(line: string | undefined | null): boolean {
  const cleaned = stripNoise((line ?? "").trim());
  if (cleaned.length === 0) return false;
  if (NOTIFY_PLACEHOLDER.test(cleaned)) return false;
  return JAPANESE.test(cleaned);
}

/**
 * Extract the human notify line from a PR body. Prefers the first content line inside the
 * "## 通知文言" section; if there is no such heading, falls back to the first content line of
 * the whole body (the "PR本文の1行目 = 通知文言" convention). Scaffolding lines (headings,
 * HTML comments, quotes, bullets) and placeholders are skipped. Returns the cleaned line, or
 * undefined when the author wrote nothing usable.
 */
export function extractNotifyLine(prBody: string | undefined | null): string | undefined {
  const body = (prBody ?? "").replace(/\r\n?/g, "\n");
  if (!body.trim()) return undefined;
  const lines = body.split("\n");

  // Locate the 通知文言 heading, if present, and scan only its section.
  let start = 0;
  let end = lines.length;
  const headingIdx = lines.findIndex((l) => /^\s*#{1,6}\s/.test(l) && NOTIFY_HEADING.test(l));
  if (headingIdx >= 0) {
    start = headingIdx + 1;
    const nextHeading = lines.slice(start).findIndex((l) => /^\s*#{1,6}\s/.test(l));
    if (nextHeading >= 0) end = start + nextHeading;
  }

  for (let i = start; i < end; i++) {
    const raw = (lines[i] ?? "").trim();
    if (!raw) continue;
    if (SCAFFOLD_LINE.test(raw)) continue;
    const cleaned = stripNoise(raw);
    if (!cleaned || NOTIFY_PLACEHOLDER.test(cleaned)) continue;
    return cleaned;
  }
  return undefined;
}

/** Format an ISO8601 instant as a readable JST date-time (YYYY年M月D日 HH:mm). Deterministic
 *  (no locale libs): shift to +09:00 and read UTC components. */
export function formatJst(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso; // never throw on a bad input — show it raw
  const d = new Date(t + 9 * 60 * 60 * 1000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

export interface DeployCopyInput {
  /** Raw PR title / commit subject (the "what changed"). */
  title?: string;
  /** Human-written notification copy (PR body 1st line). When presentable, it becomes the
   *  headline verbatim — the author said "何ができるようになったか", so we trust it over any
   *  machine humanization of the title. */
  notifyLine?: string;
  /** ISO8601 instant of the deploy/merge (already resolved by the caller). */
  createdAt: string;
  /** Merged PR / commit URL (shown as a "詳細" link when present). */
  url?: string;
}

export interface DeployCopy {
  title: string;
  body: string;
  /** The classified change, exposed so the caller can persist it in meta_json. */
  change: HumanizedChange;
}

/**
 * Build the user-friendly notification title + body for a deploy.
 *
 * Headline source (in priority order):
 *   1. input.notifyLine — the human-written PR-body line, when presentable (Japanese, not a
 *      placeholder). This is what actually tells the reader "何ができるようになったか".
 *   2. humanizeChange(title) — machine humanization of the commit title.
 *   3. a generic per-kind phrase (inside humanizeChange) when neither is presentable.
 * The genre (種別/emoji) always comes from the commit title so it reflects the real change
 * kind even when the human line is a plain sentence.
 *
 * title: "🎉 新機能: <headline>" — genre-tagged, reads as an "アップデート内容".
 * body : a short "アプリがアップデートされました" lead + the headline + 種別/更新日時 (+ 詳細 link).
 *        The raw commit SHA / ref / services summary are intentionally NOT rendered here
 *        (kept in meta_json for admin traceability) so no dev string shows to the reader.
 */
export function buildDeployCopy(input: DeployCopyInput): DeployCopy {
  const humanized = humanizeChange(input.title);
  const useLine = isPresentableNotifyLine(input.notifyLine);
  // Prefer the human notify line as the headline; keep the title-derived genre/generic flag.
  const change: HumanizedChange = useLine
    ? { ...humanized, headline: stripNoise((input.notifyLine ?? "").trim()), generic: false }
    : humanized;
  const title = `${KIND_EMOJI[change.kind]} ${change.label}: ${change.headline}`;
  const bodyLines = [
    "アプリがアップデートされました。",
    "",
    change.headline,
    "",
    `種別: ${change.label}`,
    `更新日時: ${formatJst(input.createdAt)}`,
    ...(input.url ? ["", `詳細: ${input.url}`] : []),
  ];
  return { title, body: bodyLines.join("\n"), change };
}
