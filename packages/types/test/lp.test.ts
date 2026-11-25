import { describe, it, expect } from "vitest";
import { lp } from "../src/index";

const release = { versionId: "v3.4", ticketsEnabled: false, ticketsCtaEnabled: false, proposalsEnabled: true };

describe("lp section registry", () => {
  it("every section has its default variant registered; non-hideable = header / footer", () => {
    for (const id of lp.LP_SECTION_IDS) {
      const def: lp.LpSectionDef = lp.LP_SECTION_REGISTRY[id];
      expect(Object.keys(def.variants)).toContain(def.defaultVariant);
      for (const o of Object.values(def.options ?? {})) {
        if (o.kind === "boolean") expect(typeof o.default).toBe("boolean");
        else expect(Object.keys(o.values ?? {})).toContain(o.default);
      }
    }
    expect(lp.LP_SECTION_IDS.filter((id) => !lp.LP_SECTION_REGISTRY[id].hideable)).toEqual(["header", "footer"]);
  });

  it("resolveSection fills defaults (header banner on)", () => {
    expect(lp.resolveSection(lp.defaultLayout(), "header")).toEqual({ variant: "a", visible: true, options: { banner: true } });
    const layout: lp.LpLayout = { schema: 1, sections: { header: { variant: "a", visible: true, options: { banner: false } } } };
    expect(lp.resolveSection(layout, "header").options).toEqual({ banner: false });
  });
});

describe("crowdfunding pattern (enum option)", () => {
  it("defaults to 現状のページ and accepts 支援者情報; unknown values are rejected / dropped", () => {
    expect(lp.resolveSection(lp.defaultLayout(), "crowdfunding").options).toEqual({ pattern: "current" });
    const ok = lp.validateLayout({ schema: 1, sections: { crowdfunding: { options: { pattern: "supporters" } } } });
    expect(ok.issues).toEqual([]);
    expect(lp.resolveSection(ok.layout, "crowdfunding").options).toEqual({ pattern: "supporters" });
    const bad = lp.validateLayout({ schema: 1, sections: { crowdfunding: { options: { pattern: "x" } } } });
    expect(bad.issues).toEqual([{ field: "layout.sections.crowdfunding.options.pattern", reason: "invalid" }]);
    const n = lp.normalizeLayout({ schema: 1, sections: { crowdfunding: { options: { pattern: "x" } } } });
    expect(lp.resolveSection(n, "crowdfunding").options).toEqual({ pattern: "current" });
  });
});

describe("normalizeLayout (lenient)", () => {
  it("drops unknown sections / variants / options and wrong types", () => {
    const n = lp.normalizeLayout({
      schema: 1,
      sections: {
        nope: { variant: "a" },
        program: { variant: "zzz", visible: false, options: { x: 1 } },
        header: { variant: "a", visible: false, options: { banner: "no" } },
        footer: "bad",
      },
    });
    expect(n).toEqual({
      schema: 1,
      sections: {
        program: { variant: "a", visible: false, options: {} },
        // header is not hideable → forced visible; banner of the wrong type falls back to default
        header: { variant: "a", visible: true, options: {} },
      },
    });
  });

  it("garbage → default layout", () => {
    for (const raw of [null, "x", 1, [], {}, { sections: [] }]) expect(lp.normalizeLayout(raw)).toEqual(lp.defaultLayout());
  });
});

describe("validateSiteConfig (strict)", () => {
  it("accepts a valid config and fills omitted section fields", () => {
    const r = lp.validateSiteConfig({
      layout: { schema: 1, sections: { program: { visible: false }, header: { options: { banner: false } } } },
      release,
    });
    expect(r.issues).toEqual([]);
    expect(r.config).toEqual({
      layout: {
        schema: 1,
        sections: {
          program: { variant: "a", visible: false, options: {} },
          header: { variant: "a", visible: true, options: { banner: false } },
        },
      },
      release,
    });
  });

  it("reports unknown section / variant / option, bad types and hiding a non-hideable section", () => {
    const r = lp.validateSiteConfig({
      layout: {
        schema: 1,
        sections: {
          hero2: {},
          program: { variant: "b" },
          header: { visible: false, options: { banner: "yes", color: true } },
        },
      },
      release: { ...release, versionId: "v9.9", ticketsEnabled: "on" },
    });
    expect(r.config).toBeNull();
    expect(r.issues).toEqual([
      { field: "config.layout.sections.hero2", reason: "unknown_section" },
      { field: "config.layout.sections.program.variant", reason: "unknown_variant" },
      { field: "config.layout.sections.header.visible", reason: "not_hideable" },
      { field: "config.layout.sections.header.options.banner", reason: "invalid" },
      { field: "config.layout.sections.header.options.color", reason: "unknown_option" },
      { field: "config.release.versionId", reason: "not_publishable" },
      { field: "config.release.ticketsEnabled", reason: "required" },
    ]);
  });

  it("requires layout.schema = 1 and both parts", () => {
    expect(lp.validateSiteConfig(null).issues).toEqual([{ field: "config", reason: "required" }]);
    expect(lp.validateSiteConfig({ layout: { schema: 2 }, release }).issues).toEqual([
      { field: "config.layout.schema", reason: "unsupported" },
    ]);
    expect(lp.validateSiteConfig({ layout: { schema: 1 } }).issues).toEqual([{ field: "config.release", reason: "required" }]);
  });

  it("prototype keys are not sections / variants", () => {
    const r = lp.validateLayout(JSON.parse('{"schema":1,"sections":{"toString":{},"program":{"variant":"constructor"}}}'));
    expect(r.issues.map((i) => i.reason)).toEqual(["unknown_section", "unknown_variant"]);
  });
});

describe("content sections (協力団体・お知らせ・登壇者・スポンサー)", () => {
  const news: lp.LpNewsItem = { id: "n1", date: "2026-11-22", text: "チケット販売を開始しました。", mode: "link", url: "", body: "", highlight: true };
  const on = (content: Partial<lp.LpContent>): lp.LpLayout => ({
    schema: 1,
    sections: { news: { variant: "a", visible: true, options: {} } },
    content,
  });

  it("are hidden by default and sit in the LP order (hero → news → speakers → … → sponsors → partners → contact)", () => {
    for (const id of lp.LP_CONTENT_SECTION_IDS) {
      expect(lp.LP_SECTION_REGISTRY[id].defaultVisible).toBe(false);
      expect(lp.resolveSection(lp.defaultLayout(), id).visible).toBe(false);
    }
    expect(lp.LP_SECTION_IDS.slice(0, 4)).toEqual(["header", "news", "speakers", "join"]);
    expect(lp.LP_SECTION_IDS.slice(-4)).toEqual(["sponsors", "partners", "contact", "footer"]);
  });

  it("layoutAttributes: shown only when visible AND it has items (the default stays attribute-free)", () => {
    expect(lp.layoutAttributes(lp.LP_SECTION_REGISTRY, lp.defaultLayout())).toEqual({});
    expect(lp.layoutAttributes(lp.LP_SECTION_REGISTRY, on({}))).toEqual({});
    expect(lp.layoutAttributes(lp.LP_SECTION_REGISTRY, on({ news: [news] }))).toEqual({ "data-lp-s-news": "a" });
    const hidden = { ...on({ news: [news] }), sections: { news: { variant: "a", visible: false, options: {} } } };
    expect(lp.layoutAttributes(lp.LP_SECTION_REGISTRY, hidden)).toEqual({});
  });

  it("validateLayout keeps valid items and reports bad ones by path", () => {
    const ok = lp.validateLayout(on({ news: [news] }));
    expect(ok.issues).toEqual([]);
    expect(ok.layout.content).toEqual({ news: [news] });
    // 省略した visible は既定（非表示）。
    expect(lp.validateLayout({ schema: 1, sections: { speakers: {} } }).layout.sections.speakers?.visible).toBe(false);
    const bad = lp.validateLayout(on({ news: [{ ...news, url: "javascript:x", text: "" }] }));
    expect(bad.issues).toEqual([
      { field: "layout.content.news[0].text", reason: "required" },
      { field: "layout.content.news[0].url", reason: "invalid_url" },
    ]);
  });

  it("normalizeLayout drops broken / duplicate items but keeps the rest; no content key → none added", () => {
    const raw = on({ news: [news, { ...news }, { id: "bad id", date: "x" } as never, { ...news, id: "n2", text: "  2件目  " }] });
    expect(lp.normalizeLayout(raw).content).toEqual({ news: [news, { ...news, id: "n2", text: "2件目" }] });
    expect(lp.normalizeLayout({ schema: 1, sections: {} })).toEqual(lp.defaultLayout());
  });

  it("news: items saved before mode/body existed read as link mode (no migration)", () => {
    const old = { id: "n1", date: "2026-11-22", text: "旧", url: "https://example.com", highlight: false };
    expect(lp.validateContentItem("news", old)).toEqual({ item: { ...old, mode: "link", body: "" }, issues: [] });
  });

  it("news dialog mode: body required only in dialog mode; the unused field is not checked", () => {
    const dialog = { ...news, mode: "dialog", body: "" };
    expect(lp.validateContentItem("news", dialog).issues).toEqual([{ field: "item.body", reason: "required" }]);
    expect(lp.validateContentItem("news", { ...dialog, body: "# 詳細" }).item).toMatchObject({ mode: "dialog", body: "# 詳細" });
    // dialog のとき不正な url は捨てる（エラーにしない）。link のとき body は問わない。
    expect(lp.validateContentItem("news", { ...dialog, body: "x", url: "javascript:x" })).toMatchObject({ item: { url: "" }, issues: [] });
    expect(lp.validateContentItem("news", { ...news, body: "" }).issues).toEqual([]);
    expect(lp.validateContentItem("news", { ...news, mode: "popup" }).issues).toEqual([{ field: "item.mode", reason: "invalid" }]);
    expect(lp.validateContentItem("news", { ...dialog, body: "あ".repeat(lp.LP_NEWS_BODY_MAX + 1) }).issues).toEqual([
      { field: "item.body", reason: "too_long" },
    ]);
  });

  it("isContentFieldShown follows showWhen", () => {
    const body = lp.LP_CONTENT_FIELDS.news.find((f) => f.key === "body")!;
    expect(lp.isContentFieldShown(body, { mode: "dialog" })).toBe(true);
    expect(lp.isContentFieldShown(body, { mode: "link" })).toBe(false);
  });

  it("isLpContentUrl: http(s) or an LP-relative /path only", () => {
    for (const u of ["https://example.com/a.png", "http://example.com", "/sponsors/logo.png", "https://a.b:8443/x?y=1#z"]) {
      expect(lp.isLpContentUrl(u)).toBe(true);
    }
    for (const u of ["javascript:alert(1)", "//evil.example/x", "data:image/png;base64,AA", "https://exa mple.com", "ftp://x", ""]) {
      expect(lp.isLpContentUrl(u)).toBe(false);
    }
  });
});
