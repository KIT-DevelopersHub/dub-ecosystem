// Humanization of developer change titles into reader-facing deploy-notification copy.
// The point of this suite is the before→after contract: a raw PR title / commit subject
// (conventional-commit prefix, backticks, English jargon, "(#NN)") must never survive
// verbatim into the notification title/body; the reader sees a genre tag + a plain headline.
import { describe, it, expect } from "vitest";
import { humanizeChange, buildDeployCopy, formatJst } from "../src/deployCopy";

describe("humanizeChange — genre classification + prefix/noise stripping", () => {
  // [rawTitle, expectedKind, expectedLabel, expectedHeadline]
  const cases: Array<[string, string, string, string]> = [
    // English fix with code noise + trailing PR ref → generic 修正 headline (not presentable).
    ['fix(db): don\'t mis-parse `DO UPDATE SET` "SET" as a table in the namespace guard (#224)', "fix", "修正", "不具合を修正しました"],
    // Japanese feature → presentable, prefix stripped, genre 新機能.
    ["feat: 新機能リリースを通知アプリにブロードキャスト", "feature", "新機能", "新機能リリースを通知アプリにブロードキャスト"],
    // Japanese refactor → 改善, scope + "統一プラン #2" kept (it is prose, not a PR ref).
    ["refactor(fe4): ガントのズーム切替を共通 SegmentedControl に置換（統一プラン #2）", "improvement", "改善", "ガントのズーム切替を共通 SegmentedControl に置換（統一プラン #2）"],
    // chore/deps English → generic 更新 headline.
    ["chore(deps): bump wrangler to 4.35.0", "update", "更新", "アプリを更新しました"],
    // No conventional prefix, Japanese → treated as 更新, shown as-is.
    ["ガントチャートの表示を高速化", "update", "更新", "ガントチャートの表示を高速化"],
    // Leading decorative emoji stripped (we supply our own glyph).
    ["feat: 🎉 メンバー管理を追加", "feature", "新機能", "メンバー管理を追加"],
    // perf English → 改善 generic.
    ["perf: reduce inbox query fan-out", "improvement", "改善", "使いやすさを改善しました"],
    // Empty → 更新 generic (never throws).
    ["", "update", "更新", "アプリを更新しました"],
  ];

  for (const [raw, kind, label, headline] of cases) {
    it(`"${raw.slice(0, 40)}" → ${label}`, () => {
      const h = humanizeChange(raw);
      expect(h.kind).toBe(kind);
      expect(h.label).toBe(label);
      expect(h.headline).toBe(headline);
      // The raw conventional prefix must never leak into the headline.
      expect(h.headline).not.toMatch(/^(feat|fix|chore|refactor|perf|docs|ci|build|style|test)(\(|:|!)/);
      expect(h.headline).not.toContain("`");
    });
  }
});

describe("buildDeployCopy — full notification title + body", () => {
  it("renders a genre-tagged title and a clean body (no dev string, no raw SHA/ref)", () => {
    const copy = buildDeployCopy({
      title: 'fix(db): don\'t mis-parse `DO UPDATE SET` (#224)',
      createdAt: "2026-08-17T01:30:00Z",
      url: "https://github.com/KIT-DevelopersHub/dub-ecosystem/pull/224",
    });
    expect(copy.title).toBe("🔧 修正: 不具合を修正しました");
    expect(copy.body).toContain("アプリがアップデートされました。");
    expect(copy.body).toContain("種別: 修正");
    expect(copy.body).toContain("更新日時: 2026年8月17日 10:30"); // JST (+9h)
    expect(copy.body).toContain("詳細: https://github.com/KIT-DevelopersHub/dub-ecosystem/pull/224");
    // No raw developer string anywhere in the reader-facing copy.
    expect(copy.body).not.toContain("fix(db)");
    expect(copy.body).not.toContain("DO UPDATE SET");
  });

  it("omits the 詳細 line when no url is given", () => {
    const copy = buildDeployCopy({ title: "feat: メンバー管理を追加", createdAt: "2026-08-17T00:00:00Z" });
    expect(copy.title).toBe("🎉 新機能: メンバー管理を追加");
    expect(copy.body).not.toContain("詳細:");
  });
});

describe("formatJst", () => {
  it("shifts UTC to JST and formats", () => {
    expect(formatJst("2026-08-17T15:00:00Z")).toBe("2026年8月18日 00:00");
  });
  it("returns the input unchanged on an unparseable date", () => {
    expect(formatJst("not-a-date")).toBe("not-a-date");
  });
});
