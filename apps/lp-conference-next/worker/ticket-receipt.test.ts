// Run: node --test worker/ticket-receipt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_RECEIPT, handleReceipt, jstDate, matchReceiptRoute, renderReceiptPage, type ReceiptDeps } from "./ticket-receipt.ts";
import { parseCheckoutForm, renderTicketsPage, type TicketConfig } from "./tickets.ts";
import type { LpTicketReceipt } from "../../../packages/types/src/lp-tickets.ts";

const TOKEN = "tko_01ABCDEFGHJKMNPQRSTVWXYZ01.abcdefghijklmnopqrstuvwx";
const XSS = '<script>alert("x")</script>';
const R: LpTicketReceipt = { ...DEMO_RECEIPT, test: false, orderNumber: "ABCD1234", receiptName: "株式会社テスト" };

function deps(answer: (path: string, init: RequestInit) => Response | Promise<Response>): ReceiptDeps & { calls: { path: string; init: RequestInit }[] } {
  const calls: { path: string; init: RequestInit }[] = [];
  return {
    demo: false,
    calls,
    internal: async (path, init) => {
      calls.push({ path, init });
      return answer(path, init);
    },
  };
}
const go = (path: string, d: ReceiptDeps, init: RequestInit = {}) => {
  const url = new URL(path, "https://lp.example");
  return handleReceipt(new Request(url, init), matchReceiptRoute(url.pathname)!, d);
};
const postName = (name: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ receiptName: name }).toString(),
});

test("matchReceiptRoute: owns /receipt only", () => {
  assert.deepEqual(matchReceiptRoute(`/receipt/${TOKEN}`), { token: TOKEN });
  assert.deepEqual(matchReceiptRoute(`/receipt/${TOKEN}/`), { token: TOKEN });
  for (const p of ["/receipt", "/receipt/x", `/receipt/${TOKEN}/extra`, "/receipt/..%2F"]) assert.deepEqual(matchReceiptRoute(p), { token: null });
  assert.equal(matchReceiptRoute("/receipts"), null);
  assert.equal(matchReceiptRoute(`/t/${TOKEN}`), null);
});

test("jstDate is the Japanese calendar day", () => {
  assert.equal(jstDate("2026-10-07T03:00:00.000Z"), "2026年10月7日");
  assert.equal(jstDate("2026-10-07T16:00:00.000Z"), "2026年10月8日");
});

test("render: amount incl. tax, items, order no., date, issuer; unset issuer fields are marked, not invented", () => {
  const html = renderReceiptPage(R, TOKEN);
  for (const s of ["領収書", "株式会社テスト 様", "No. ABCD1234", "¥6,000", "（税込）", "一般（Day 1）", "2026年10月7日", "一般社団法人 Developers Hub", "info@developershub.jp", "クレジットカード", "【所在地 未設定】"]) {
    assert.ok(html.includes(s), s);
  }
  assert.ok(!html.includes("登録番号"));
  assert.ok(!html.includes("消費税"));
  assert.ok(!html.includes("<form"), "宛名 already set: no form");
  assert.ok(html.includes("@media print"));
  const inv = renderReceiptPage({ ...R, taxJpy: 545, issuer: { ...R.issuer, invoiceRegistrationNo: "T7000012050002", address: "石川県" } }, TOKEN);
  assert.ok(inv.includes("登録番号 T7000012050002"));
  assert.ok(inv.includes("うち消費税（10%） ¥545"));
  assert.ok(!inv.includes("未設定"));
  // 会計アプリの設定: 事務局名・電話・税率がそのまま出る。
  const custom = renderReceiptPage(
    { ...R, taxJpy: 444, issuer: { ...R.issuer, office: "DevHub 会計担当", phone: "076-000-0000", taxRatePercent: 8, invoiceRegistrationNo: "T7000012050002" } },
    TOKEN,
  );
  assert.ok(custom.includes("DevHub 会計担当"));
  assert.ok(custom.includes("TEL 076-000-0000"));
  assert.ok(custom.includes("うち消費税（8%） ¥444"));
  assert.ok(!html.includes("TEL "), "no phone line when unset");
});

test("render: form only while the 宛名 is empty; void notes for refunded / test", () => {
  const empty = renderReceiptPage({ ...R, receiptName: null }, TOKEN);
  assert.ok(empty.includes(`action="/receipt/${TOKEN}"`));
  assert.ok(empty.includes('name="receiptName"'));
  assert.ok(renderReceiptPage({ ...R, status: "refunded" }, TOKEN).includes("返金済みのため、この領収書は無効"));
  assert.ok(!renderReceiptPage({ ...R, status: "refunded", receiptName: null }, TOKEN).includes("<form"));
  assert.ok(renderReceiptPage({ ...R, test: true }, TOKEN).includes("テスト購入のため"));
});

test("render escapes every dynamic text", () => {
  const html = renderReceiptPage(
    { ...R, receiptName: XSS, items: [{ ...R.items[0]!, ticketTypeName: XSS, dayLabel: XSS }], issuer: { ...R.issuer, address: XSS, office: XSS, phone: XSS } },
    TOKEN,
  );
  assert.ok(!html.includes("<script>alert"));
});

test("GET: relays the receipt with private headers; 404 / 503 otherwise", async () => {
  const d = deps(() => Response.json(R));
  const res = await go(`/receipt/${TOKEN}`, d);
  assert.equal(res.status, 200);
  assert.equal(d.calls[0]!.path, `/lp/internal/tickets/receipt/${encodeURIComponent(TOKEN)}`);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("cache-control"), "no-store, no-transform");
  assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.ok((await res.text()).includes("ABCD1234"));
  assert.equal((await go(`/receipt/${TOKEN}`, deps(() => new Response("{}", { status: 404 })))).status, 404);
  assert.equal((await go("/receipt/nope", d)).status, 404);
  assert.equal((await go(`/receipt/${TOKEN}`, deps(() => new Response("", { status: 500 })))).status, 503);
  assert.equal((await go(`/receipt/${TOKEN}`, { demo: false, internal: null })).status, 503);
  assert.equal((await go(`/receipt/${TOKEN}`, d, { method: "PUT" })).status, 405);
});

test("POST: sets the 宛名 then redirects (PRG); 409 also redirects; bad input re-renders 400", async () => {
  const d = deps(() => Response.json(R));
  const res = await go(`/receipt/${TOKEN}`, d, postName("  株式会社A  "));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `/receipt/${TOKEN}`);
  assert.equal(d.calls[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(d.calls[0]!.init.body as string), { receiptName: "株式会社A" });

  assert.equal((await go(`/receipt/${TOKEN}`, deps(() => new Response("{}", { status: 409 })), postName("x"))).status, 303);

  const empty = deps(() => Response.json({ ...R, receiptName: null }));
  const bad = await go(`/receipt/${TOKEN}`, empty, postName(""));
  assert.equal(bad.status, 400);
  assert.ok((await bad.text()).includes("宛名を入力してください"));
  assert.equal(empty.calls.length, 1, "nothing is sent for an empty name; only the reload");
  assert.equal(empty.calls[0]!.init.method, undefined);

  const long = await go(`/receipt/${TOKEN}`, deps(() => Response.json({ ...R, receiptName: null })), postName("あ".repeat(61)));
  assert.equal(long.status, 400);

  const rejected = deps((_p, init) => (init.method === "POST" ? new Response("{}", { status: 400 }) : Response.json({ ...R, receiptName: null })));
  assert.equal((await go(`/receipt/${TOKEN}`, rejected, postName("ok"))).status, 400);
});

test("demo mode serves only /receipt/demo", async () => {
  const d: ReceiptDeps = { demo: true, internal: null };
  assert.equal((await go("/receipt/demo", d)).status, 200);
  assert.equal((await go(`/receipt/${TOKEN}`, d)).status, 404);
});

const CFG = {
  enabled: true,
  preview: false,
  ctaEnabled: false,
  paymentReady: true,
  paymentMethods: ["card"],
  types: [{ id: "general", name: "一般", description: "", priceJpy: 3000, remaining: null, soldOut: false, dayLabel: "", maxPerOrder: 10, couponOnly: false }],
  fields: [],
} as unknown as TicketConfig;

test("/tickets form: optional 宛名 for paid orders, passed through and length-checked", () => {
  const html = renderTicketsPage({ config: CFG });
  assert.ok(html.includes('name="receiptName"'));
  const ok = parseCheckoutForm(new URLSearchParams({ qty_general: "1", name: "山田", email: "a@example.com", receiptName: " 株式会社B " }), CFG);
  assert.ok(ok.ok && ok.input.receiptName === "株式会社B");
  const none = parseCheckoutForm(new URLSearchParams({ qty_general: "1", name: "山田", email: "a@example.com" }), CFG);
  assert.ok(none.ok && !("receiptName" in none.input));
  const long = parseCheckoutForm(new URLSearchParams({ qty_general: "1", name: "山田", email: "a@example.com", receiptName: "あ".repeat(61) }), CFG);
  assert.ok(!long.ok && long.errors.receiptName);
});
