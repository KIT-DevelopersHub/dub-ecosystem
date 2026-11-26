import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { DEFAULT_DUB_API_BASE, insightsApiBase, insightsScript, insightsTag } from "./insights.ts";
import { parseInsightBeacon } from "../../../packages/types/src/lp-insights.ts";

type Handler = (e: Record<string, unknown>) => void;

/** 計測スクリプトを最小の偽 DOM で動かし、送ったビーコンを返す。 */
function run(opts: { search?: string; path?: string; dnt?: boolean; storage?: Map<string, string>; purchase?: boolean } = {}) {
  const sent: { url: string; body: string }[] = [];
  const docHandlers: Record<string, Handler[]> = {};
  const winHandlers: Record<string, Handler[]> = {};
  const storage = opts.storage ?? new Map<string, string>();
  const link = (href: string, sectionId: string | null) => ({
    id: "",
    getAttribute: () => href,
    hasAttribute: () => false,
    closest: (sel: string) => {
      if (sel === "a[href],[data-lp-tk]") return link(href, sectionId);
      if (sel === "section[id]") return sectionId ? { id: sectionId } : null;
      return null;
    },
  });
  const document = {
    visibilityState: "visible",
    referrer: "https://l.instagram.com/",
    documentElement: { scrollHeight: 4000 },
    querySelector: (sel: string) => (sel === "[data-lp-purchase]" && opts.purchase ? {} : null),
    querySelectorAll: () => [],
    addEventListener: (t: string, h: Handler) => (docHandlers[t] ??= []).push(h),
  };
  const window = {
    scrollY: 0,
    innerHeight: 1000,
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    },
    addEventListener: (t: string, h: Handler) => (winHandlers[t] ??= []).push(h),
  };
  const ctx = {
    window,
    document,
    navigator: {
      doNotTrack: opts.dnt ? "1" : "unspecified",
      sendBeacon: (url: string, blob: { text: string }) => {
        sent.push({ url, body: blob.text });
        return true;
      },
    },
    location: { pathname: opts.path ?? "/", search: opts.search ?? "", href: `https://hokuriku-it-conf.com${opts.path ?? "/"}`, origin: "https://hokuriku-it-conf.com" },
    URL,
    URLSearchParams,
    JSON,
    Math,
    Date,
    Array,
    Blob: class {
      text: string;
      constructor(parts: string[]) {
        this.text = parts.join("");
      }
    },
  };
  runInNewContext(insightsScript("https://api.example/"), ctx);
  return {
    sent,
    scroll(y: number) {
      window.scrollY = y;
      winHandlers.scroll?.forEach((h) => h({}));
    },
    click(href: string, section: string | null) {
      docHandlers.click?.forEach((h) => h({ target: link(href, section) }));
    },
    hide() {
      document.visibilityState = "hidden";
      docHandlers.visibilitychange?.forEach((h) => h({}));
      winHandlers.pagehide?.forEach((h) => h({}));
    },
  };
}

test("insights: one beacon on hide with scroll, CTA clicks and the session's utm tags", () => {
  const page = run({ search: "?utm_source=instagram&utm_medium=social&utm_campaign=early" });
  page.scroll(3000);
  page.click("/tickets", "join");
  page.click("#program", null);
  page.click("https://camp-fire.jp/projects/1", "crowdfunding");
  page.click("mailto:info@example.com", "contact");
  assert.equal(page.sent.length, 0, "nothing is sent while the page is open");
  page.hide();
  assert.equal(page.sent.length, 1, "visibilitychange + pagehide still send once");
  assert.equal(page.sent[0]!.url, "https://api.example/api/v1/public/lp-events");
  const b = JSON.parse(page.sent[0]!.body);
  assert.equal(b.first, true);
  assert.equal(b.src, "instagram");
  assert.equal(b.med, "social");
  assert.equal(b.cmp, "early");
  assert.equal(b.ref, "https://l.instagram.com/");
  assert.equal(b.scroll, 100);
  assert.deepEqual(b.cta, ["tickets@join", "nav@page", "out:camp-fire.jp@crowdfunding", "contact@contact"]);
  // gateway の検証を通る形。
  assert.ok(parseInsightBeacon(b));
});

test("insights: the session (sessionStorage only) carries the source; funnel steps are counted once", () => {
  const storage = new Map<string, string>();
  run({ search: "?utm_source=x", storage }).hide();
  const tickets = run({ path: "/tickets", storage });
  tickets.hide();
  const b = JSON.parse(tickets.sent[0]!.body);
  assert.equal(b.first, false);
  assert.equal(b.src, "x");
  assert.equal(b.ref, null);
  assert.deepEqual(b.steps, ["tickets"]);
  const again = run({ path: "/tickets/", storage });
  again.hide();
  assert.deepEqual(JSON.parse(again.sent[0]!.body).steps, [], "reloading the tickets page is not a second step");
  const thanks = run({ path: "/tickets/thanks", storage, purchase: true });
  thanks.hide();
  assert.deepEqual(JSON.parse(thanks.sent[0]!.body).steps, ["purchase"]);
  // 保存しているのは流入元と段階だけ（ID は持たない）。
  assert.deepEqual(Object.keys(JSON.parse(storage.get("dub_lp_s")!)).sort(), ["cmp", "med", "src", "steps", "t"]);
});

test("insights: Do Not Track → nothing is sent", () => {
  const page = run({ dnt: true });
  page.hide();
  assert.equal(page.sent.length, 0);
});

test("insightsApiBase / insightsTag", () => {
  assert.equal(insightsApiBase({}), DEFAULT_DUB_API_BASE);
  assert.equal(insightsApiBase({ LP_INSIGHTS: "off" }), null);
  assert.equal(insightsApiBase({ TICKETS_DEMO: "1" }), null);
  assert.equal(insightsApiBase({ TICKETS_DEMO: "1", DUB_API_BASE: "http://127.0.0.1:9" }), "http://127.0.0.1:9");
  assert.ok(insightsTag("https://a").startsWith('<script id="lp-insights">'));
  assert.ok(!insightsTag("https://a").includes("</script><"), "single script tag");
});
