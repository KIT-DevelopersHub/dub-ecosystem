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
  const slot = (id: string, top: number) => ({
    getAttribute: () => id,
    classList: { add: () => {}, remove: () => {} },
    // display:contents のスロットは高さ 0。中の最初の要素で測る。
    getBoundingClientRect: () => ({ top: 0, height: 0 }),
    querySelectorAll: () => [
      { getBoundingClientRect: () => ({ top: top - win.scrollY, height: 100 }), classList: { add: () => {}, remove: () => {} } },
    ],
  });
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
  const classes = new Set<string>();
  const ctx = vm.createContext({
    window: win,
    location: win.location,
    document: {
      readyState: "complete",
      referrer: opts.referrer ?? "",
      querySelectorAll: (q: string) => (q === "[data-lp-slot]" ? slots : []),
      addEventListener: (t: string, f: Listener) => (docListeners[t] ??= []).push(f),
      documentElement: { classList: { add: (c: string) => classes.add(c) } },
      createElement: () => ({ textContent: "" }),
      head: { appendChild: () => {} },
    },
    requestAnimationFrame: win.requestAnimationFrame,
    URL,
    Date,
    Math,
    JSON,
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
  return { win, parent, posted, scrolled, fire, click, classes };
}

test("posts the section list and the active section to an allowed parent only", () => {
  const ok = run({ ancestor: "http://localhost:5191" });
  assert.deepEqual(ok.posted.map((p) => p.target), ["http://localhost:5191"]);
  assert.deepEqual(JSON.parse(JSON.stringify(ok.posted[0]!.msg)), {
    type: "lp:sections",
    sections: [
      { id: "header", top: 0 },
      { id: "join", top: 1000 },
      { id: "program", top: 2000 },
    ],
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
