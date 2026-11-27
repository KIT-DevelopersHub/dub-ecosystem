import { describe, it, expect, vi, afterEach } from "vitest";
import { createDbClient } from "@dub/db";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import {
  AUTOHEAL_MIN_AGE_MS,
  ResendSuppressionsClient,
  annotate,
  pickRemovable,
  suppressionNote,
  sweepSuppressions,
  type Suppression,
} from "../src/resend-suppressions";
import { makeEnv } from "./helpers";

const app = createApp();
afterEach(() => vi.unstubAllGlobals());

const NOW = Date.parse("2026-11-28T00:00:00Z");
const OLD = "2026-11-27 10:48:14.903+00";

const raw = (email: string, over: Record<string, unknown> = {}) => ({ id: `sup_${email.split("@")[0]}`, email, origin: "bounce", source_id: "em_x", created_at: OLD, ...over });

/** One fake for both upstreams: Cloudflare rules (enabled receiving rules for `ruleAddrs`)
 *  and Resend /suppressions (list = `suppressed`, GET/DELETE by address). */
function stubUpstreams(opts: { suppressed: ReturnType<typeof raw>[]; ruleAddrs?: string[]; resendStatus?: number }) {
  const calls: Array<{ method: string; url: string }> = [];
  const store = [...opts.suppressed];
  const fake = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    if (url.startsWith("https://api.resend.com/")) {
      if (opts.resendStatus) return new Response("{}", { status: opts.resendStatus });
      const m = url.match(/\/suppressions\/([^?]+)$/);
      if (!m) return new Response(JSON.stringify({ object: "list", has_more: false, data: store }), { status: 200 });
      const email = decodeURIComponent(m[1]!);
      const i = store.findIndex((s) => s.email === email);
      if (i < 0) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      if (method === "DELETE") {
        store.splice(i, 1);
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }
      return new Response(JSON.stringify(store[i]), { status: 200 });
    }
    const rules = (opts.ruleAddrs ?? []).map((a, i) => ({
      id: `r${i}`,
      name: `dub-issued:${a.split("@")[0]}`,
      enabled: true,
      priority: 0,
      matchers: [{ type: "literal", field: "to", value: a }],
      actions: [{ type: "worker", value: ["dub-mail-gateway"] }],
    }));
    return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: rules }), { status: 200 });
  });
  vi.stubGlobal("fetch", fake);
  return { calls, store, fake };
}

function resendEnv(over: Partial<Env> = {}) {
  return makeEnv({
    MAIL_OUTBOUND_PROVIDER: "resend",
    RESEND_API_KEY: "re_test",
    CF_EMAIL_ROUTING_TOKEN: "cf-secret",
    CF_EMAIL_ROUTING_ZONE_ID: "zone_1",
    CF_EMAIL_ROUTING_ACCOUNT_ID: "acc_1",
    ...over,
  } as Partial<Env>);
}

const adminHeaders = { "x-dub-request-id": "req_sup", "x-dub-user-id": "usr_admin" };

describe("ResendSuppressionsClient", () => {
  it("pages through the list with `after`", async () => {
    const pages = [
      { has_more: true, data: [raw("a@developershub.jp")] },
      { has_more: false, data: [raw("b@developershub.jp")] },
    ];
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ object: "list", ...pages[urls.length - 1] }), { status: 200 });
    });
    const list = await new ResendSuppressionsClient("k", f as unknown as typeof fetch).list();
    expect(list.map((s) => s.email)).toEqual(["a@developershub.jp", "b@developershub.jp"]);
    expect(urls[1]).toContain("after=sup_a");
  });

  it("get: 404 = not suppressed; 403 = MAIL_SUPPRESSIONS_UNAVAILABLE (API not enabled for the account)", async () => {
    const c404 = new ResendSuppressionsClient("k", (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch);
    expect(await c404.get("x@developershub.jp")).toBeNull();
    const c403 = new ResendSuppressionsClient("k", (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch);
    await expect(c403.get("x@developershub.jp")).rejects.toMatchObject({ code: "MAIL_SUPPRESSIONS_UNAVAILABLE", status: 503 });
  });
});

/** Like Workers' native fetch: throws "Illegal invocation" unless called with this = globalThis/undefined. */
function stubStrictThisFetch(inner: (url: string, init?: RequestInit) => Promise<Response>) {
  const strict = function (this: unknown, url: string, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect `this` reference");
    return inner(url, init);
  };
  vi.stubGlobal("fetch", strict);
}

describe("default fetch (no fetchImpl injected)", () => {
  it("the cron sweep reaches Resend without Illegal invocation (prod 2026-11-28)", async () => {
    const { fake, store } = stubUpstreams({ suppressed: [raw("member@developershub.jp")], ruleAddrs: ["member@developershub.jp"] });
    stubStrictThisFetch(fake);
    const { env } = resendEnv({ MAIL_SUPPRESSION_AUTOHEAL: "true" } as Partial<Env>);
    const out = await sweepSuppressions(env, createDbClient(env.DB, { namespace: "mail" }), NOW);
    expect(out).toMatchObject({ enabled: true, error: null, removed: ["member@developershub.jp"] });
    expect(store).toHaveLength(0);
  });

  it("a transport failure keeps the original error message", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network down");
    });
    await expect(new ResendSuppressionsClient("k").list()).rejects.toMatchObject({
      code: "MAIL_PROVIDER_UNAVAILABLE",
      message: expect.stringContaining("TypeError: network down"),
    });
  });
});

describe("pickRemovable", () => {
  const s = (email: string, over: Partial<Suppression> = {}): Suppression => ({ id: `sup_${email}`, email, origin: "bounce", sourceId: null, createdAt: OLD, ...over });
  const views = annotate(
    [
      s("member@developershub.jp"),
      s("norule@developershub.jp"),
      s("someone@gmail.com"),
      s("spam@developershub.jp", { origin: "complaint" }),
      s("fresh@developershub.jp", { createdAt: new Date(NOW - AUTOHEAL_MIN_AGE_MS + 60_000).toISOString() }),
      s("cooled@developershub.jp"),
    ],
    "developershub.jp",
    new Set(["member@developershub.jp", "spam@developershub.jp", "fresh@developershub.jp", "cooled@developershub.jp"]),
  );

  it("only own-zone bounce suppressions whose receiving rule is enabled, old enough, not in cooldown", () => {
    expect(pickRemovable(views, new Set(["cooled@developershub.jp"]), NOW).map((v) => v.email)).toEqual(["member@developershub.jp"]);
  });

  it("annotates external addresses as not internal (never auto-removed)", () => {
    expect(views.find((v) => v.email === "someone@gmail.com")).toMatchObject({ internal: false, receivingRuleEnabled: null });
    expect(views.find((v) => v.email === "norule@developershub.jp")).toMatchObject({ internal: true, receivingRuleEnabled: false });
  });
});

describe("sweepSuppressions (cron auto-heal)", () => {
  it("does nothing unless MAIL_SUPPRESSION_AUTOHEAL=true", async () => {
    const { fake } = stubUpstreams({ suppressed: [raw("member@developershub.jp")], ruleAddrs: ["member@developershub.jp"] });
    const { env } = resendEnv();
    const out = await sweepSuppressions(env, createDbClient(env.DB, { namespace: "mail" }), NOW);
    expect(out).toMatchObject({ enabled: false, removed: [] });
    expect(fake).not.toHaveBeenCalled();
  });

  it("removes a member address whose rule now works, records it, and skips it within the cooldown", async () => {
    const { calls, store } = stubUpstreams({
      suppressed: [raw("member@developershub.jp"), raw("gone@developershub.jp"), raw("someone@gmail.com")],
      ruleAddrs: ["member@developershub.jp"],
    });
    const { env, raw: sql } = resendEnv({ MAIL_SUPPRESSION_AUTOHEAL: "true" } as Partial<Env>);
    const db = createDbClient(env.DB, { namespace: "mail" });
    const out = await sweepSuppressions(env, db, NOW);
    expect(out).toMatchObject({ enabled: true, checked: 3, removed: ["member@developershub.jp"], skipped: 2, error: null });
    expect(store.map((s) => s.email).sort()).toEqual(["gone@developershub.jp", "someone@gmail.com"]);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    const ev = sql.prepare(`SELECT event_type, recipient_key, reason FROM mail_provider_event`).get() as { event_type: string; recipient_key: string; reason: string };
    expect(ev).toMatchObject({ event_type: "dub.suppression_removed", recipient_key: "member@developershub.jp" });
    expect(ev.reason).toContain("auto-heal");

    // Bounced again -> back on the list: within 7 days the sweep leaves it alone.
    store.push(raw("member@developershub.jp", { id: "sup_member2" }));
    const again = await sweepSuppressions(env, db, NOW + 60 * 60_000);
    expect(again.removed).toEqual([]);
  });

  it("reports (never throws) when the Suppressions API is not available", async () => {
    stubUpstreams({ suppressed: [], ruleAddrs: ["member@developershub.jp"], resendStatus: 403 });
    const { env } = resendEnv({ MAIL_SUPPRESSION_AUTOHEAL: "true" } as Partial<Env>);
    const out = await sweepSuppressions(env, createDbClient(env.DB, { namespace: "mail" }), NOW);
    expect(out.error).toContain("not available");
  });
});

describe("admin routes /mail/admin/email-routing/suppressions", () => {
  it("GET lists suppressions with the own-zone / receiving-rule annotation", async () => {
    stubUpstreams({ suppressed: [raw("member@developershub.jp"), raw("someone@gmail.com")], ruleAddrs: ["member@developershub.jp"] });
    const { env } = resendEnv();
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/suppressions", { headers: adminHeaders }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ email: string; internal: boolean; receivingRuleEnabled: boolean | null; origin: string }> };
    expect(body.items).toEqual([
      expect.objectContaining({ email: "member@developershub.jp", internal: true, receivingRuleEnabled: true, origin: "bounce" }),
      expect.objectContaining({ email: "someone@gmail.com", internal: false, receivingRuleEnabled: null }),
    ]);
  });

  it("DELETE removes one address, audits it, and records it", async () => {
    const { store } = stubUpstreams({ suppressed: [raw("member@developershub.jp")] });
    const { env, sends, raw: sql } = resendEnv();
    const res = await app.fetch(
      new Request("https://svc/mail/admin/email-routing/suppressions/member%40developershub.jp", { method: "DELETE", headers: adminHeaders }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "member@developershub.jp", removed: true });
    expect(store).toHaveLength(0);
    expect(sends.audit.some((a) => (a.payload as { action?: string; result?: string }).action === "mail.suppression.remove")).toBe(true);
    const ev = sql.prepare(`SELECT reason FROM mail_provider_event WHERE event_type = 'dub.suppression_removed'`).get() as { reason: string };
    expect(ev.reason).toContain("usr_admin");
  });

  it("DELETE of an address that is not suppressed is a no-op (removed=false)", async () => {
    stubUpstreams({ suppressed: [] });
    const { env } = resendEnv();
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/suppressions/x%40developershub.jp", { method: "DELETE", headers: adminHeaders }), env);
    expect(await res.json()).toEqual({ email: "x@developershub.jp", removed: false });
  });

  it("503 MAIL_SUPPRESSIONS_UNAVAILABLE when the provider is not Resend", async () => {
    const { env } = makeEnv();
    const res = await app.fetch(new Request("https://svc/mail/admin/email-routing/suppressions", { headers: adminHeaders }), env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("MAIL_SUPPRESSIONS_UNAVAILABLE");
  });
});

describe("suppressionNote (canary To-missing detail)", () => {
  it("names the suppression when the canary's To is on the list, else empty", async () => {
    stubUpstreams({ suppressed: [raw("dev-monitor@developershub.jp")] });
    const { env } = resendEnv();
    expect(await suppressionNote(env, "dev-monitor@developershub.jp")).toContain("送信停止リストに登録（bounce");
    expect(await suppressionNote(env, "qa-a@developershub.jp")).toBe("");
    expect(await suppressionNote(makeEnv().env, "dev-monitor@developershub.jp")).toBe("");
  });
});
