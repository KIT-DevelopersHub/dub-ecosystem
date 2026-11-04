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
