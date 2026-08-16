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

  return { kind, label: KIND_LABEL[kind], headline, generic: !presentable, cleaned };
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
 * title: "🎉 新機能: <headline>" — genre-tagged, reads as an "アップデート内容".
 * body : a short "アプリがアップデートされました" lead + the headline + 種別/更新日時 (+ 詳細 link).
 *        The raw commit SHA / ref / services summary are intentionally NOT rendered here
 *        (kept in meta_json for admin traceability) so no dev string shows to the reader.
 */
export function buildDeployCopy(input: DeployCopyInput): DeployCopy {
  const change = humanizeChange(input.title);
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
