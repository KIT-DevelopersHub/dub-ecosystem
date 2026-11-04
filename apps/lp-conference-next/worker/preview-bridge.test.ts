// Run: node --test worker/preview-bridge.test.ts (Node >= 22.18 strips TS types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  BRIDGE_ORIGINS,
  bridgeOriginAllowed,
  bridgeScript,
  parseExtraOrigins,
  shouldInjectBridge,
} from "./preview-bridge.ts";

test("injects only on preview HTML pages of versions that have section slots", () => {
  assert.equal(shouldInjectBridge({ page: true, siteConfig: true, previewing: true }), true);
  assert.equal(shouldInjectBridge({ page: true, siteConfig: true, previewing: false }), false, "public view");
  assert.equal(shouldInjectBridge({ page: true, siteConfig: false, previewing: true }), false, "old version");
  assert.equal(shouldInjectBridge({ page: false, siteConfig: true, previewing: true }), false, "not html");
});

test("origin allowlist: fe2 origins + localhost ports + https extras; never wildcard", () => {
  for (const o of BRIDGE_ORIGINS) assert.equal(bridgeOriginAllowed(o), true);
  assert.equal(bridgeOriginAllowed("http://localhost:5191"), true);
  assert.equal(bridgeOriginAllowed("http://127.0.0.1:4173"), true);
  assert.equal(bridgeOriginAllowed("https://evil.example"), false);
  assert.equal(bridgeOriginAllowed("http://localhost.evil.example"), false);
  assert.equal(bridgeOriginAllowed("https://app.developershub.jp.evil.example"), false);
  assert.deepEqual(parseExtraOrigins(" https://a.example ,http://b.example,https://c.example/path,*"), ["https://a.example"]);
  assert.equal(bridgeOriginAllowed("https://a.example", ["https://a.example"]), true);
  assert.doesNotMatch(bridgeScript(), /postMessage\([^)]*["']\*["']/);
});

type Listener = (e: unknown) => void;

/** スロット 3 つ（top: 0 / 1000 / 2000）を持つ偽の LP ページで script を動かす。 */
function run(opts: { ancestor?: string; referrer?: string }) {
  const listeners: Record<string, Listener[]> = {};
  const posted: { msg: unknown; target: string }[] = [];
  const scrolled: unknown[] = [];
  const parent = { postMessage: (msg: unknown, target: string) => posted.push({ msg, target }) };
  const slot = (id: string, top: number) => {
    const child = {
      getBoundingClientRect: () => ({ top: top - win.scrollY, bottom: top - win.scrollY + 100, height: 100 }),
      classList: { add: () => {}, remove: () => {} },
    };
    return {
      getAttribute: () => id,
      classList: { add: () => {}, remove: () => {} },
      // display:contents のスロットは高さ 0。中の要素で測る。
      getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }),
      children: [child],
      querySelectorAll: () => [child],
    };
  };
  const slots = [slot("header", 0), slot("join", 1000), slot("program", 2000)];
  const win: Record<string, unknown> & { scrollY: number } = {
    scrollY: 0,
    innerHeight: 800,
    parent,
    location: { ancestorOrigins: opts.ancestor ? [opts.ancestor] : [] },
    addEventListener: (t: string, f: Listener) => (listeners[t] ??= []).push(f),
    // 同期で呼ぶ偽物。戻り値 0 = 「予約なし」に戻る（本物は次のフレームで呼ぶ）。
    requestAnimationFrame: (f: () => void) => {
      f();
      return 0;
    },
    scrollTo: (o: unknown) => scrolled.push(o),
  };
  const docListeners: Record<string, Listener[]> = {};
  // 100svh の要素（ヒーロー）と、画面の高さに関係ない要素。
  const tall = [
    { style: { minHeight: "" }, cs: { minHeight: "800px" } },
    { style: { minHeight: "" }, cs: { minHeight: "120px" } },
  ];
  const observed: unknown[] = [];
  const classes = new Set<string>();
  // <html> の属性（Worker が付けた公開設定の属性 + 関係ない属性）。
  const htmlAttrs = new Map<string, string>([
    ["lang", "ja"],
    ["data-lp-s-join", "off"],
    ["data-lp-o-header-banner", "off"],
  ]);
  const ctx = vm.createContext({
    window: win,
    location: win.location,
    document: {
      readyState: "complete",
      referrer: opts.referrer ?? "",
      querySelectorAll: (q: string) => (q === "[data-lp-slot]" ? slots : []),
      addEventListener: (t: string, f: Listener) => (docListeners[t] ??= []).push(f),
      documentElement: {
        classList: { add: (c: string) => classes.add(c) },
        scrollHeight: 3000,
        get attributes() {
          return [...htmlAttrs.keys()].map((name) => ({ name }));
        },
        removeAttribute: (k: string) => htmlAttrs.delete(k),
        setAttribute: (k: string, v: string) => htmlAttrs.set(k, v),
      },
      body: { querySelectorAll: () => tall },
      createElement: () => ({ textContent: "" }),
      head: { appendChild: () => {} },
    },
    requestAnimationFrame: win.requestAnimationFrame,
    URL,
    Date,
    Math,
    JSON,
    getComputedStyle: (el: { cs: unknown }) => el.cs,
    ResizeObserver: class {
      constructor(_f: unknown) {}
      observe(t: unknown) {
        observed.push(t);
      }
    },
    setTimeout,
    clearTimeout,
  });
  const js = bridgeScript().replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
  vm.runInContext(js, ctx);
  const fire = (t: string, e: unknown = {}) => (listeners[t] ?? []).forEach((f) => f(e));
  const click = (section: string) => {
    let prevented = false;
    const e = {
      target: { closest: () => slots.find((s) => s.getAttribute() === section) },
      preventDefault: () => (prevented = true),
      stopPropagation: () => {},
    };
    (docListeners.click ?? []).forEach((f) => f(e));
    return prevented;
  };
  return { win, parent, posted, scrolled, fire, click, classes, tall, observed, htmlAttrs };
}

test("posts the section list and the active section to an allowed parent only", () => {
  const ok = run({ ancestor: "http://localhost:5191" });
  assert.deepEqual(ok.posted.map((p) => p.target), ["http://localhost:5191"]);
  assert.deepEqual(JSON.parse(JSON.stringify(ok.posted[0]!.msg)), {
    type: "lp:sections",
    sections: [
      { id: "header", top: 0, height: 100 },
      { id: "join", top: 1000, height: 100 },
      { id: "program", top: 2000, height: 100 },
    ],
    docHeight: 3000,
    caps: ["config"],
  });
  // 読み込んだだけでは lp:scroll を送らない（親の設定画面を勝手に動かさない）。スクロールして別のセクションが上に来たら知らせる。
  ok.fire("scroll");
  assert.equal(ok.posted.length, 1);
  ok.win.scrollY = 900;
  ok.fire("scroll");
  assert.deepEqual(JSON.parse(JSON.stringify(ok.posted.at(-1)!.msg)), { type: "lp:scroll", activeSection: "join" });

  const evil = run({ ancestor: "https://evil.example", referrer: "https://evil.example/x" });
  assert.equal(evil.posted.length, 0);
});

test("scrolls to a section only for messages from the parent with an allowed origin, and stays quiet meanwhile", () => {
  const b = run({ referrer: "https://app.developershub.jp/lp" });
  const before = b.posted.length;
  b.fire("message", { source: {}, origin: "https://app.developershub.jp", data: { type: "lp:scrollTo", section: "program" } });
  b.fire("message", { source: b.parent, origin: "https://evil.example", data: { type: "lp:scrollTo", section: "program" } });
  assert.equal(b.scrolled.length, 0);
  b.fire("message", { source: b.parent, origin: "https://app.developershub.jp", data: { type: "lp:scrollTo", section: "program" } });
  assert.deepEqual(JSON.parse(JSON.stringify(b.scrolled)), [{ top: 1992, behavior: "smooth" }]);
  // 頼まれたスクロールの途中経過は送り返さない（ループ防止）。
  b.win.scrollY = 1100;
  b.fire("scroll");
  assert.equal(b.posted.length, before);
});

test("adopts the parent origin from a hello when referrer/ancestorOrigins are missing", () => {
  const b = run({});
  assert.equal(b.posted.length, 0);
  b.fire("message", { source: b.parent, origin: "https://fe2-demo.developershub-site.workers.dev", data: { type: "lp:hello" } });
  assert.equal(b.posted[0]!.target, "https://fe2-demo.developershub-site.workers.dev");
});

test("select mode (asked by the editor only): a click on a section is reported instead of navigating", () => {
  const b = run({ ancestor: "http://localhost:5195" });
  // 頼まれていない（全画面プレビュー）ときはクリックを横取りしない。
  assert.equal(b.click("program"), false);
  b.fire("message", { source: b.parent, origin: "http://localhost:5195", data: { type: "lp:hello", select: true } });
  assert.equal(b.classes.has("lp-edit"), true);
  assert.equal(b.click("program"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(b.posted.at(-1)!.msg)), { type: "lp:select", section: "program" });
});

test("fit mode (iframe drawn at full height): pins viewport-tall min-heights and keeps reporting the layout", () => {
  const b = run({ ancestor: "http://localhost:5195" });
  b.fire("message", { source: b.parent, origin: "http://localhost:5195", data: { type: "lp:hello", select: true, fit: 900 } });
  assert.equal(b.tall[0]!.style.minHeight, "900px", "100svh hero is pinned instead of growing with the iframe");
  assert.equal(b.tall[1]!.style.minHeight, "", "unrelated elements are untouched");
  assert.equal(b.observed.length, 1, "observes the body to resend lp:sections on layout changes");
  // 2 回目の hello（読み直し後の再送依頼）で監視を重ねない。
  b.fire("message", { source: b.parent, origin: "http://localhost:5195", data: { type: "lp:hello", select: true, fit: 900 } });
  assert.equal(b.observed.length, 1);
  // lp:mark はスクロールせずに選択の枠だけ。
  const before = b.scrolled.length;
  b.fire("message", { source: b.parent, origin: "http://localhost:5195", data: { type: "lp:mark", section: "join" } });
  assert.equal(b.scrolled.length, before);
});

test("lp:config swaps the site-config attributes on <html> instantly (validated, allowed parent only)", () => {
  const b = run({ ancestor: "http://localhost:5199" });
  const before = b.posted.length;
  // 許可されていないオリジン・親以外からは何もしない。
  b.fire("message", { source: b.parent, origin: "https://evil.example", data: { type: "lp:config", attrs: { "data-lp-s-program": "off" } } });
  b.fire("message", { source: {}, origin: "http://localhost:5199", data: { type: "lp:config", attrs: { "data-lp-s-program": "off" } } });
  assert.equal(b.htmlAttrs.has("data-lp-s-program"), false);
  b.fire("message", {
    source: b.parent,
    origin: "http://localhost:5199",
    data: {
      type: "lp:config",
      attrs: {
        "data-lp-s-program": "off",
        "data-lp-o-crowdfunding-pattern": "backers",
        onclick: "alert(1)",
        style: "display:none",
        "data-lp-s-about": "<img src=x>",
        "data-lp-x-about": "off",
        "data-lp-s-vision": 1,
      },
    },
  });
  assert.deepEqual(Object.fromEntries(b.htmlAttrs), {
    lang: "ja",
    "data-lp-s-program": "off",
    "data-lp-o-crowdfunding-pattern": "backers",
  });
  // 付け替えた後は位置が変わるので lp:sections を送り直す（親が設定の帯を置き直す）。
  assert.equal(b.posted.length, before + 1);
  assert.equal((b.posted.at(-1)!.msg as { type: string }).type, "lp:sections");
  // 既定値に戻す = 空の attrs で全部外れる。
  b.fire("message", { source: b.parent, origin: "http://localhost:5199", data: { type: "lp:config", attrs: {} } });
  assert.deepEqual(Object.fromEntries(b.htmlAttrs), { lang: "ja" });
});
