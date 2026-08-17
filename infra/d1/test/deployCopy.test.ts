// Humanization of developer change titles into reader-facing deploy-notification copy.
// The point of this suite is the before→after contract: a raw PR title / commit subject
// (conventional-commit prefix, backticks, English jargon, "(#NN)") must never survive
// verbatim into the notification title/body; the reader sees a genre tag + a plain headline.
import { describe, it, expect } from "vitest";
import {
  humanizeChange,
  buildDeployCopy,
  formatJst,
  extractNotifyLine,
  isPresentableNotifyLine,
  detectConventionalType,
} from "../src/deployCopy";

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

// ---- PR-body notify line (通知文言) --------------------------------------------------------

const PR_TEMPLATE_BODY = `## 通知文言（ユーザー向け・1行）

<!-- ここに1行で書く -->

使用量ダッシュボードを全メンバーに開放しました

## 試せる場所（任意）

ランチャー → 使用量

---

## 変更内容（開発者向け）

- usage-service に /usage/all を追加
`;

describe("extractNotifyLine — pull the human 通知文言 out of a PR body", () => {
  it("reads the first content line under the 通知文言 heading", () => {
    expect(extractNotifyLine(PR_TEMPLATE_BODY)).toBe("使用量ダッシュボードを全メンバーに開放しました");
  });

  it("skips HTML comments, headings, bullets and the placeholder", () => {
    const body = `## 通知文言\n<!-- ここに1行で書く -->\n（ここに1行で書く）\n\nロールの権限をその場でトグル編集できるようにしました\n`;
    expect(extractNotifyLine(body)).toBe("ロールの権限をその場でトグル編集できるようにしました");
  });

  it("falls back to the 1st content line when there is no 通知文言 heading", () => {
    const body = `ガントチャートにタスクの期間バーを表示しました\n\n詳細な説明...\n`;
    expect(extractNotifyLine(body)).toBe("ガントチャートにタスクの期間バーを表示しました");
  });

  it("returns undefined for an empty / placeholder-only / comment-only body", () => {
    expect(extractNotifyLine("")).toBeUndefined();
    expect(extractNotifyLine("## 通知文言\n\n（ここに1行で書く）\n")).toBeUndefined();
    expect(extractNotifyLine("<!-- nothing here -->")).toBeUndefined();
  });

  it("normalizes CRLF line endings", () => {
    expect(extractNotifyLine("## 通知文言\r\n\r\nメール受信の不具合を修正しました\r\n")).toBe(
      "メール受信の不具合を修正しました",
    );
  });
});

describe("isPresentableNotifyLine", () => {
  it("accepts real Japanese copy", () => {
    expect(isPresentableNotifyLine("使用量ダッシュボードを開放しました")).toBe(true);
  });
  it("rejects empty, placeholder and English-only lines", () => {
    expect(isPresentableNotifyLine("")).toBe(false);
    expect(isPresentableNotifyLine("（ここに1行で書く）")).toBe(false);
    expect(isPresentableNotifyLine("add usage dashboard")).toBe(false);
  });
});

describe("detectConventionalType", () => {
  it("extracts the leading conventional-commit type", () => {
    expect(detectConventionalType("fix(db): guard")).toBe("fix");
    expect(detectConventionalType("docs: readme")).toBe("docs");
    expect(detectConventionalType("チャートを速くした")).toBeUndefined();
  });
});

describe("buildDeployCopy — human notify line wins over title humanization", () => {
  it("uses the notify line verbatim as the headline, keeping the title-derived genre", () => {
    const copy = buildDeployCopy({
      title: "feat(usage): add usage dashboard route", // English → would be generic 新機能
      notifyLine: "使用量ダッシュボードを全メンバーに開放しました",
      createdAt: "2026-08-17T00:00:00Z",
    });
    expect(copy.title).toBe("🎉 新機能: 使用量ダッシュボードを全メンバーに開放しました");
    expect(copy.change.generic).toBe(false);
    expect(copy.body).toContain("使用量ダッシュボードを全メンバーに開放しました");
    expect(copy.body).not.toContain("usage dashboard");
  });

  it("falls back to title humanization when the notify line is not presentable", () => {
    const copy = buildDeployCopy({
      title: "feat: メンバー管理を追加",
      notifyLine: "（ここに1行で書く）", // placeholder → ignored
      createdAt: "2026-08-17T00:00:00Z",
    });
    expect(copy.title).toBe("🎉 新機能: メンバー管理を追加");
  });
});
