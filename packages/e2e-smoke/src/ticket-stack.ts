// チケット購入 → 決済 → 発券 → 当日受付 の E2E スタック（#897）。
//
// 本物のコードをそのままつなぐ:
//   公開 LP Worker（apps/lp-conference-next/worker の handleTickets / handlePass）
//     → service binding 相当 → lp-tickets（services/lp-tickets の Hono app・D1 repo・SQL）
//     → D1 dub-tickets（node:sqlite に services/lp-tickets/db の migration を全部当てたもの）
// 偽物は通信の継ぎ目だけ:
//   - Stripe API = テストモード（sk_test_）だけを受ける偽 Stripe。Checkout Session の作成・取得と、
//     支払い後の署名付き webhook（本物と同じ Stripe-Signature）を作る。本番キーは受け付けない。
//   - メール = 送信内容を配列に貯める（Resend の代わり）
//   - api-gateway = /api/v1 を外して x-dub-user-id を付けるだけ（権限の判定は lp-tickets の policyGate が行う）
//
// vitest（test/ticket-to-checkin.test.ts）と Playwright（apps/fe2-app-shell/e2e/ticket-to-checkin.spec.ts）の
// 両方から使う。外部へは一切通信しない。
import { createDbClient, newId } from "@dub/db";
import type { PermissionGranter } from "@dub/policy-gate";
import { policy } from "@dub/types";
import type { identity } from "@dub/types";
import { memoryD1 } from "../../../infra/d1/src/node-d1";
import { createApp } from "../../../services/lp-tickets/src/app";
import { createD1TicketRepo } from "../../../services/lp-tickets/src/d1-repo";
import type { OutboundMail } from "../../../services/lp-tickets/src/mailer";
import { createStripeClient, isLiveKey, signStripePayload } from "../../../services/lp-tickets/src/stripe";
import { TicketService } from "../../../services/lp-tickets/src/tickets";
import type { AppDeps, LpTicketRepo } from "../../../services/lp-tickets/src/types";
import { ticketsSchemas } from "./d1";

/** Stripe のテストカード。これ以外の番号は支払い失敗（card_declined）として扱う。 */
export const TEST_CARD_OK = "4242424242424242";
export const TEST_CARD_DECLINED = "4000000000000002";

export const STAFF = { admin: "usr_e2e_admin", reception: "usr_e2e_reception" } as const;

export interface TicketStackOptions {
  /** 公開 LP の origin（チケット URL・QR の中身になる）。外へ出ない .invalid を既定にする。 */
  lpOrigin?: string;
  /** 偽 Stripe Checkout のページの origin。 */
  checkoutOrigin?: string;
  /** テストキーのみ（sk_test_）。sk_live_ / rk_live_ を渡すと作成時に止まる。 */
  stripeSecretKey?: string;
  webhookSecret?: string;
}

interface FakeSession {
  id: string;
  status: "open" | "complete" | "expired";
  payment_status: "unpaid" | "paid";
  amount_total: number;
  currency: "jpy";
  livemode: false;
  client_reference_id: string | null;
  metadata: { order_id: string | null };
  success_url: string;
  cancel_url: string;
  customer_email: string | null;
  payment_intent: string | null;
}

// 公開 LP Worker は Node の --strip-types で動く独立した書き方（.ts 拡張子の import・別の tsconfig）なので、
// この package の tsc に巻き込まないよう実行時に読み込み、使う所だけ型を付ける。
type Internal = (path: string, init: RequestInit) => Promise<Response>;
interface LpTicketsWorker {
  handleTickets(req: Request, deps: Record<string, unknown>): Promise<Response | null>;
  internalFetch(binding: { fetch(input: string, init?: RequestInit): Promise<Response> }, host: string, demo: boolean): Internal | null;
  parseConfig(raw: unknown): unknown;
  FailureLimiter: new (max: number, windowMs: number) => unknown;
}
interface LpPassWorker {
  matchPassRoute(pathname: string): unknown;
  handlePass(req: Request, route: unknown, deps: { demo: boolean; internal: Internal | null }): Promise<Response>;
}
const workerModule = <T>(file: string): Promise<T> =>
  import(/* @vite-ignore */ new URL(`../../../apps/lp-conference-next/worker/${file}`, import.meta.url).href) as Promise<T>;

export type TicketStack = Awaited<ReturnType<typeof createTicketStack>>;

function authzFor(): PermissionGranter {
  const lp = (level: policy.AppAccessLevel) => policy.keysForAppLevel("lp", level) as identity.PermissionKey[];
  const byUser = new Map<string, Set<identity.PermissionKey>>([
    [STAFF.admin, new Set([...lp("edit"), "lp:publish", "lp:checkin"] as identity.PermissionKey[])],
    // 受付係: LP管理の閲覧 + lp:checkin だけ（購入者一覧・券種には触れない）。
    [STAFF.reception, new Set([...lp("view"), "lp:checkin"] as identity.PermissionKey[])],
  ]);
  return async (userId, _orgId, keys) => keys.filter((k) => byUser.get(userId)?.has(k) ?? false);
}

export async function createTicketStack(o: TicketStackOptions = {}) {
  const lpOrigin = o.lpOrigin ?? "https://lp.e2e.invalid";
  const checkoutOrigin = o.checkoutOrigin ?? "https://checkout.stripe.e2e.invalid";
  const stripeKey = o.stripeSecretKey ?? "sk_test_e2e_not_a_real_key";
  const whsec = o.webhookSecret ?? "whsec_e2e_not_a_real_secret";
  // 本番キーを絶対に使わない。テストキー以外はここで止める。
  if (!stripeKey.startsWith("sk_test_") || isLiveKey(stripeKey)) {
    throw new Error("ticket E2E runs in Stripe TEST mode only (sk_test_...). Refusing a non-test key.");
  }

  // ---- clock (reconcile は 5 分より古い注文だけを見るので、進められるようにする) ----
  let offsetMs = 0;
  const nowMs = () => Date.now() + offsetMs;
  const now = () => new Date(nowMs()).toISOString();

  // ---- D1 dub-tickets ----
  const { db } = memoryD1();
  for (const sql of ticketsSchemas()) await db.exec(sql);
  const repo: LpTicketRepo = createD1TicketRepo(createDbClient(db, { namespace: "lp" }));

  // ---- fake Stripe (test mode) ----
  const sessions = new Map<string, FakeSession>();
  const stripeCalls: { method: string; path: string; auth: string | null }[] = [];
  let seq = 0;
  const stripeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const u = new URL(url);
    const auth = new Headers(init?.headers).get("authorization");
    stripeCalls.push({ method, path: u.pathname, auth });
    if (u.origin !== "https://api.stripe.com") return new Response("unexpected host", { status: 500 });
    if (auth !== `Bearer ${stripeKey}`) return Response.json({ error: { code: "api_key_invalid" } }, { status: 401 });
    if (method === "POST" && u.pathname === "/v1/checkout/sessions") {
      const f = new URLSearchParams(String(init?.body ?? ""));
      let amount = 0;
      for (let i = 0; f.has(`line_items[${i}][quantity]`); i++) {
        if (f.get(`line_items[${i}][price_data][currency]`) !== "jpy") return Response.json({ error: { code: "currency" } }, { status: 400 });
        amount += Number(f.get(`line_items[${i}][price_data][unit_amount]`)) * Number(f.get(`line_items[${i}][quantity]`));
      }
      const id = `cs_test_e2e_${String(seq++).padStart(4, "0")}`;
      const s: FakeSession = {
        id,
        status: "open",
        payment_status: "unpaid",
        amount_total: amount,
        currency: "jpy",
        livemode: false,
        client_reference_id: f.get("client_reference_id"),
        metadata: { order_id: f.get("metadata[order_id]") },
        success_url: f.get("success_url") ?? "",
        cancel_url: f.get("cancel_url") ?? "",
        customer_email: f.get("customer_email"),
        payment_intent: null,
      };
      sessions.set(id, s);
      return Response.json({ ...s, url: `${checkoutOrigin}/c/pay/${id}` });
    }
    const m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(u.pathname);
    if (method === "GET" && m) {
      const s = sessions.get(decodeURIComponent(m[1]!));
      if (!s) return Response.json({ error: { code: "resource_missing" } }, { status: 404 });
      const expand = u.searchParams.getAll("expand[]").includes("payment_intent.payment_method");
      return Response.json({
        ...s,
        payment_intent: s.payment_intent && expand ? { id: s.payment_intent, payment_method: { id: "pm_e2e", type: "card" } } : s.payment_intent,
      });
    }
    if (method === "POST" && u.pathname === "/v1/refunds") {
      return Response.json({ id: `re_test_e2e_${seq++}`, status: "succeeded", amount: null });
    }
    return Response.json({ error: { code: "not_implemented_in_fake" } }, { status: 404 });
  };
  const stripe = createStripeClient(stripeKey, stripeFetch);

  // ---- mail (Resend の代わり) ----
  const mails: OutboundMail[] = [];
  const pending = new Set<Promise<unknown>>();

  const deps: AppDeps = {
    repo,
    authz: authzFor(),
    lpBaseUrl: lpOrigin,
    now,
    newTicketTypeId: () => `tkt_e2e${String(seq++).padStart(6, "0")}`,
    newOrderId: () => newId("tko"),
    newCouponId: () => `tkc_e2e${String(seq++).padStart(6, "0")}`,
    stripe,
    stripeWebhookSecret: whsec,
    armReconcile: null,
    paypayEnabled: false,
    ticketPreviewKey: null,
    mailer: {
      send: async (mail) => {
        mails.push(mail);
        return { ok: true, id: `re_e2e_${mails.length}` };
      },
    },
    ticketTokenSecret: "e2e-ticket-token-secret",
    ticketOpsEmail: "ops@e2e.invalid",
    ticketMailFrom: "北陸ITカンファレンス <info@e2e.invalid>",
    ticketMailDailyCap: null,
    backup: null,
    defer: (work) => {
      const p = work.finally(() => pending.delete(p));
      pending.add(p);
    },
    sleep: async () => {},
    loadIssuer: async () => null,
  };
  const ticketsApp = createApp(deps);
  const settle = async () => {
    while (pending.size > 0) await Promise.all([...pending]);
  };

  const { FailureLimiter, handleTickets, internalFetch, parseConfig } = await workerModule<LpTicketsWorker>("tickets.ts");
  const { handlePass, matchPassRoute } = await workerModule<LpPassWorker>("ticket-pass.ts");

  // ---- 公開 LP Worker（本物の handleTickets / handlePass。LP_TICKETS binding = lp-tickets app） ----
  const binding = { fetch: (input: string, init?: RequestInit) => Promise.resolve(ticketsApp.fetch(new Request(input, init))) };
  const internal = internalFetch(binding, "lp-tickets", false)!;
  const couponLimiter = new FailureLimiter(1000, 60_000);
  const lp = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pass = matchPassRoute(url.pathname);
    const res = pass
      ? await handlePass(req, pass, { demo: false, internal })
      : ((await handleTickets(req, {
          demo: false,
          getConfig: async () => {
            const r = await internal("/lp/internal/tickets", {});
            return r.ok ? parseConfig(await r.json()) : null;
          },
          invalidate: () => {},
          internal,
          couponLimiter,
        })) ?? new Response("Not Found", { status: 404 }));
    await settle();
    return res;
  };

  // ---- api-gateway 相当（fe2 → /api/v1/lp/tickets*） ----
  const gateway = async (req: Request, userId: string = STAFF.reception): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (!path.startsWith("/lp/tickets")) return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    const headers = new Headers(req.headers);
    for (const k of [...headers.keys()]) if (k.startsWith("x-dub-")) headers.delete(k);
    headers.set("x-dub-user-id", userId);
    headers.set("x-dub-request-id", `req_e2e_${seq++}`);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const res = await ticketsApp.fetch(new Request(`https://lp-tickets${path}${url.search}`, { method: req.method, headers, body }));
    await settle();
    return res;
  };

  /** LP管理（admin）から JSON API を叩く。 */
  const admin = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await gateway(
      new Request(`https://api.e2e.invalid/api/v1${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      STAFF.admin,
    );
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };

  /** Stripe が LP の /tickets/stripe-webhook へ送るのと同じ、署名付きのイベント。 */
  const webhookEvent = async (type: string, session: FakeSession, eventId = `evt_test_e2e_${seq++}`) => {
    const raw = JSON.stringify({ id: eventId, object: "event", type, livemode: false, data: { object: session } });
    const signature = await signStripePayload(raw, whsec, Math.floor(nowMs() / 1000));
    return { eventId, raw, signature };
  };
  const postWebhook = (raw: string, signature: string) =>
    lp(new Request(`${lpOrigin}/tickets/stripe-webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body: raw }));

  /**
   * Checkout で支払う（Stripe のテストカードだけ）。成功なら checkout.session.completed を LP に送り、
   * 購入者が戻る success_url を返す。`deliverWebhook: false` で webhook が届かない障害を再現する。
   */
  const pay = async (sessionId: string, card: string, opts: { deliverWebhook?: boolean } = {}) => {
    const s = sessions.get(sessionId);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    if (s.status !== "open") throw new Error(`session ${sessionId} is ${s.status}`);
    if (card.replace(/\s+/g, "") !== TEST_CARD_OK) return { ok: false as const, reason: "card_declined", redirectTo: null, webhook: null };
    s.status = "complete";
    s.payment_status = "paid";
    s.payment_intent = `pi_test_e2e_${seq++}`;
    const redirectTo = s.success_url.replace("{CHECKOUT_SESSION_ID}", s.id);
    if (opts.deliverWebhook === false) return { ok: true as const, reason: null, redirectTo, webhook: null };
    const ev = await webhookEvent("checkout.session.completed", s);
    const res = await postWebhook(ev.raw, ev.signature);
    return { ok: true as const, reason: null, redirectTo, webhook: { ...ev, status: res.status } };
  };

  /** 公開 LP の /tickets フォームを送る（ブラウザのフォーム送信と同じ x-www-form-urlencoded）。 */
  const submitCheckout = (form: Record<string, string>) =>
    lp(
      new Request(`${lpOrigin}/tickets/checkout`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: lpOrigin },
        body: new URLSearchParams(form).toString(),
        redirect: "manual",
      }),
    );

  /** 購入確認メールに書かれたチケット URL（= QR の中身）。 */
  const ticketUrlsIn = (mail: OutboundMail): string[] => {
    const re = new RegExp(`${lpOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/t/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{24}`, "g");
    return [...new Set(mail.text.match(re) ?? [])];
  };

  /** 受付（fe2 の受付画面が送るのと同じ POST /api/v1/lp/tickets/checkin）。 */
  const checkin = async (code: string, eventDay?: string, userId: string = STAFF.reception) => {
    const res = await gateway(
      new Request("https://api.e2e.invalid/api/v1/lp/tickets/checkin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, ...(eventDay ? { eventDay } : {}) }),
      }),
      userId,
    );
    return { status: res.status, body: (await res.json()) as { result: string; [k: string]: unknown } };
  };

  /** cron の照合（webhook が届かない時の安全網）。 */
  const reconcile = async () => {
    const r = await new TicketService(deps).reconcile();
    await settle();
    return r;
  };

  return {
    lpOrigin,
    checkoutOrigin,
    repo,
    deps,
    mails,
    sessions,
    stripeCalls,
    lp,
    gateway,
    admin,
    pay,
    postWebhook,
    webhookEvent,
    submitCheckout,
    ticketUrlsIn,
    checkin,
    reconcile,
    advance: (ms: number) => {
      offsetMs += ms;
    },
    now,
  };
}
