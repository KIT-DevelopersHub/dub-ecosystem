// Run: node --test worker/site-config.test.ts (Node >= 22.18 strips TS types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LpSectionDef } from "../../../packages/types/src/lp.ts";
import { siteConfigCss, layoutAttributes } from "../src/sections/slots.ts";
import {
  createSiteConfigSource,
  draftCookie,
  draftPreview,
  DRAFT_TTL_MS,
  htmlAttributes,
  parseSiteConfig,
  PUBLISHED_TTL_MS,
  supportsSiteConfig,
} from "./site-config.ts";

const at = (path: string) => new URL(path, "https://lp.example");

// 本物の登録簿はバリアントが a だけなので、b・enum を持つテスト用の登録簿でも確かめる。
const REG: Record<string, LpSectionDef> = {
  header: {
    label: "h",
    hideable: false,
    defaultVariant: "a",
    variants: { a: "A" },
    options: { banner: { kind: "boolean", label: "帯", default: true } },
  },
  program: {
    label: "p",
    hideable: true,
    defaultVariant: "a",
    variants: { a: "A", b: "B" },
    options: {
      dense: { kind: "boolean", label: "詰める", default: false },
      tone: { kind: "enum", label: "色", default: "light", values: { light: "明", dark: "暗" } },
    },
  },
};
const layout = (sections: Record<string, unknown>) => ({ schema: 1 as const, sections }) as Parameters<typeof layoutAttributes>[1];

test("supportsSiteConfig: v3.6 以降だけ", () => {
  assert.equal(supportsSiteConfig("v3.6"), true);
  assert.equal(supportsSiteConfig("v3.10"), true);
  assert.equal(supportsSiteConfig("v4.0"), true);
  assert.equal(supportsSiteConfig("v3.5"), false);
  assert.equal(supportsSiteConfig("v2.0"), false);
  assert.equal(supportsSiteConfig("latest"), false);
});

test("draftPreview: ?config=draft > cookie > same-origin referer; live clears", () => {
  assert.equal(draftPreview(at("/?config=draft"), null), true);
  assert.equal(draftPreview(at("/"), "lp_config=draft"), true);
  assert.equal(draftPreview(at("/"), null), false);
  assert.equal(draftPreview(at("/?config=live"), "lp_config=draft"), false);
  assert.equal(draftPreview(at("/?version=live"), "lp_config=draft"), false);
  assert.equal(draftPreview(at("/_next/x.js"), null, "https://lp.example/?config=draft"), true);
  assert.equal(draftPreview(at("/_next/x.js"), null, "https://evil.example/?config=draft"), false);
  assert.equal(draftPreview(at("/"), "lp_config=bogus"), false);
});

test("draftCookie: set 1h on draft, clear on live, nothing otherwise", () => {
  assert.equal(draftCookie(at("/?config=draft")), "lp_config=draft; Path=/; SameSite=None; Secure; HttpOnly; Max-Age=3600");
  assert.equal(draftCookie(at("/?config=live")), "lp_config=; Path=/; SameSite=None; Secure; HttpOnly; Max-Age=0");
  assert.equal(draftCookie(at("/?version=live")), "lp_config=; Path=/; SameSite=None; Secure; HttpOnly; Max-Age=0");
  assert.equal(draftCookie(at("/")), null);
});

test("parseSiteConfig normalizes and drops unknown values; draft falls back to published", () => {
  const p = parseSiteConfig({
    published: { schema: 1, sections: { program: { variant: "zzz", visible: false, options: {} }, nope: {} } },
    draft: { schema: 1, sections: { header: { variant: "a", visible: false, options: { banner: false } } } },
  });
  assert.deepEqual(p?.published.sections, { program: { variant: "a", visible: false, options: {} } });
  // header は hideable でないので visible は true に戻る。
  assert.deepEqual(p?.draft.sections, { header: { variant: "a", visible: true, options: { banner: false } } });
  const noDraft = parseSiteConfig({ published: { schema: 1, sections: {} } });
  assert.deepEqual(noDraft?.draft, noDraft?.published);
  assert.equal(parseSiteConfig(null), null);
  assert.equal(parseSiteConfig({ draft: {} }), null);
});

test("htmlAttributes: defaults → no attributes; banner off / hidden section → attributes", () => {
  assert.deepEqual(htmlAttributes(null), {});
  assert.deepEqual(htmlAttributes({ schema: 1, sections: {} }), {});
  assert.deepEqual(
    htmlAttributes({ schema: 1, sections: { header: { variant: "a", visible: true, options: { banner: true } } } }),
    {},
  );
  assert.deepEqual(
    htmlAttributes({
      schema: 1,
      sections: {
        header: { variant: "a", visible: true, options: { banner: false } },
        program: { variant: "a", visible: false, options: {} },
      },
    }),
    { "data-lp-o-header-banner": "off", "data-lp-s-program": "off" },
  );
});

test("layoutAttributes: non-default variant / options only; hideable-only off", () => {
  assert.deepEqual(
    layoutAttributes(REG, layout({ program: { variant: "b", visible: true, options: { dense: true, tone: "dark" } } })),
    { "data-lp-s-program": "b", "data-lp-o-program-dense": "on", "data-lp-o-program-tone": "dark" },
  );
  assert.deepEqual(layoutAttributes(REG, layout({ program: { variant: "a", visible: true, options: { dense: false, tone: "light" } } })), {});
  assert.deepEqual(layoutAttributes(REG, layout({ header: { variant: "a", visible: false, options: {} } })), {});
  assert.deepEqual(layoutAttributes(REG, layout({ program: { variant: "zzz", visible: true, options: { tone: "neon" } } })), {});
});

test("siteConfigCss: default variant shown without attributes; known values switch; hidden + nav", () => {
  const css = siteConfigCss(REG).split("\n");
  assert.ok(css.includes("[data-lp-slot],[data-lp-slot]>[data-lp-variant]{display:contents}"));
  assert.ok(css.includes('[data-lp-slot="program"]>[data-lp-variant]:not([data-lp-variant="a"]){display:none}'));
  assert.ok(css.includes('html[data-lp-s-program="b"] [data-lp-slot="program"]>[data-lp-variant="b"]{display:contents}'));
  assert.ok(css.includes('html[data-lp-s-program="b"] [data-lp-slot="program"]>[data-lp-variant="a"]{display:none}'));
  assert.ok(
    css.includes('html[data-lp-s-program="off"] [data-lp-slot="program"],html[data-lp-s-program="off"] [data-lp-nav="program"]{display:none!important}'),
  );
  // header は hideable でないので off のルールは無い。
  assert.ok(!css.some((r) => r.includes('data-lp-s-header="off"')));
  assert.ok(css.includes('html[data-lp-o-header-banner="off"] [data-lp-opt="header-banner"]{display:none!important}'));
  assert.ok(css.includes('html:not([data-lp-o-program-dense="on"]) [data-lp-opt="program-dense"]{display:none!important}'));
  assert.ok(css.includes('html:not([data-lp-o-program-tone="dark"]) [data-lp-opt="program-tone"][data-lp-opt-value="dark"]{display:none!important}'));
  assert.ok(css.includes('html[data-lp-o-program-tone="dark"] [data-lp-opt="program-tone"][data-lp-opt-value="light"]{display:none!important}'));
});

test("siteConfigCss rejects ids that would break the selector", () => {
  assert.throws(() => siteConfigCss({ 'x"]{}': { label: "x", hideable: true, defaultVariant: "a", variants: { a: "A" } } }));
  assert.throws(() => siteConfigCss({ x: { label: "x", hideable: true, defaultVariant: "off", variants: { off: "A" } } }));
});

function fakeFetch(responses: Array<unknown | Error>) {
  const calls: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.equal(new Headers(init.headers).get("x-dub-internal"), "1");
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next === 500) return new Response("err", { status: 500 });
    return new Response(JSON.stringify(next), { headers: { "content-type": "application/json" } });
  };
  return { fetcher, calls };
}

const PUB = { schema: 1, sections: { program: { variant: "a", visible: false, options: {} } } };
const DRAFT = { schema: 1, sections: { about: { variant: "a", visible: false, options: {} } } };

test("source: published cached 30s, draft refetched after 3s from the same cache", async () => {
  let t = 1_000_000;
  const { fetcher, calls } = fakeFetch([{ published: PUB, draft: DRAFT }, { published: PUB, draft: DRAFT }, { published: PUB, draft: DRAFT }]);
  const source = createSiteConfigSource(fetcher, () => t);
  assert.deepEqual((await source(false))?.sections, { program: { variant: "a", visible: false, options: {} } });
  t += DRAFT_TTL_MS - 1;
  assert.deepEqual((await source(true))?.sections, { about: { variant: "a", visible: false, options: {} } });
  assert.equal(calls.length, 1);
  t += 1;
  await source(true); // draft: 3s で取り直す
  assert.equal(calls.length, 2);
  t += PUBLISHED_TTL_MS - 1;
  await source(false);
  assert.equal(calls.length, 2);
  t += 1;
  await source(false);
  assert.equal(calls.length, 3);
  assert.equal(calls[0], "https://lp-analytics/lp/internal/site-config");
});

test("source: failure keeps the last good value; never fetched → null (defaults)", async () => {
  let t = 0;
  const { fetcher } = fakeFetch([new Error("down"), { published: PUB, draft: DRAFT }, 500, { nope: true }]);
  const source = createSiteConfigSource(fetcher, () => t);
  assert.equal(await source(false), null);
  t += PUBLISHED_TTL_MS;
  assert.ok(await source(false));
  t += PUBLISHED_TTL_MS;
  assert.deepEqual((await source(false))?.sections, PUB.sections);
  t += PUBLISHED_TTL_MS;
  assert.deepEqual((await source(false))?.sections, PUB.sections);
});

test("source without a service binding (demo) → null, never throws", async () => {
  assert.equal(await createSiteConfigSource(null)(false), null);
  assert.equal(await createSiteConfigSource(null)(true), null);
});
