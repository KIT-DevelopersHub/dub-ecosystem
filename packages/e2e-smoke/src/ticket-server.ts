// チケット E2E のブラウザ版（#897）が相手にする HTTP サーバー。createTicketStack() をそのまま公開する。
//   /tickets*, /t/*          公開 LP（本物の handleTickets / handlePass）
//   /c/pay/:id               偽 Stripe Checkout（テストカードだけ。4242... で支払い → 署名付き webhook → success_url）
//   /api/v1/me, /auth/*      fe2 の起動に要る最小限（受付係 = LP管理の閲覧 + lp:checkin）
//   /api/v1/lp/tickets*      api-gateway 相当（lp-tickets へ）
//   /__e2e/reset, /mails     テスト用（新しいスタックに作り直す・送ったメールのチケット URL）
// 起動は apps/fe2-app-shell/e2e/ticket-stack-server.mjs。localhost だけで待ち受け、外へは通信しない。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createTicketStack, STAFF, type TicketStack } from "./ticket-stack";

const RECEPTION_ME = {
  user: { id: STAFF.reception, displayName: "受付 太郎", avatarUrl: null, email: "reception@e2e.invalid" },
  orgId: "org_e2e",
  permissions: ["identity:read", "app:lp:view", "lp:checkin"],
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function checkoutPage(sessionId: string, amount: number, error?: string): Response {
  const body =
    `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Stripe テスト決済（E2E）</title></head><body>` +
    `<h1>テスト決済</h1><p data-testid="amount">¥${amount.toLocaleString("ja-JP")}</p>` +
    (error ? `<p role="alert">${escape(error)}</p>` : "") +
    `<form method="post" action="/c/pay/${encodeURIComponent(sessionId)}">` +
    `<label for="card">カード番号</label><input id="card" name="card" autocomplete="off" required>` +
    `<button type="submit">支払う</button></form></body></html>`;
  return new Response(body, { status: error ? 402 : 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const method = req.method ?? "GET";
  return new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
}

async function send(res: ServerResponse, r: Response, extra: Record<string, string> = {}): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(r.status, { ...headers, ...extra });
  res.end(Buffer.from(await r.arrayBuffer()));
}

export async function startTicketServer(port: number): Promise<{ close(): Promise<void> }> {
  const origin = `http://127.0.0.1:${port}`;
  const fresh = () => createTicketStack({ lpOrigin: origin, checkoutOrigin: origin });
  let s: TicketStack = await fresh();

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/__e2e/reset" && req.method === "POST") {
      s = await fresh();
      const body = (await req.json().catch(() => ({}))) as { types?: unknown[] };
      const types = [];
      for (const t of body.types ?? []) types.push(await s.admin("POST", "/lp/tickets/types", t));
      await s.admin("POST", "/lp/tickets/enabled", { enabled: true });
      return Response.json({ types });
    }
    if (p === "/__e2e/coupon" && req.method === "POST") return Response.json(await s.admin("POST", "/lp/tickets/coupons", await req.json()));
    if (p === "/__e2e/mails") {
      return Response.json(s.mails.map((m) => ({ to: m.to, subject: m.subject, ticketUrls: s.ticketUrlsIn(m) })));
    }

    const pay = /^\/c\/pay\/([^/]+)$/.exec(p);
    if (pay) {
      const id = decodeURIComponent(pay[1]!);
      const session = s.sessions.get(id);
      if (!session) return new Response("unknown session", { status: 404 });
      if (req.method === "POST") {
        const card = new URLSearchParams(await req.text()).get("card") ?? "";
        const r = await s.pay(id, card);
        if (!r.ok) return checkoutPage(id, session.amount_total, "カードが拒否されました（テストカード以外）");
        return new Response(null, { status: 303, headers: { location: r.redirectTo! } });
      }
      return checkoutPage(id, session.amount_total);
    }

    if (p.startsWith("/api/v1/")) {
      if (p === "/api/v1/me" && req.method === "GET") {
        return Response.json({ ...RECEPTION_ME, sessionExpiresAt: Date.now() + 60 * 60 * 1000 });
      }
      if (p === "/api/v1/auth/refresh") return Response.json({});
      if (p.startsWith("/api/v1/lp/tickets")) return s.gateway(req, STAFF.reception);
      return Response.json({ error: { code: "NOT_FOUND", message: "not in the ticket E2E stack" } }, { status: 404 });
    }

    return s.lp(req);
  };

  const server = createServer((req, res) => {
    const cors: Record<string, string> = {};
    const o = req.headers.origin;
    if (o && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o) && req.url?.startsWith("/api/")) {
      cors["access-control-allow-origin"] = o;
      cors["access-control-allow-credentials"] = "true";
      cors["access-control-allow-headers"] = req.headers["access-control-request-headers"] ?? "content-type";
      cors["access-control-allow-methods"] = "GET,POST,PUT,PATCH,DELETE";
      cors["vary"] = "origin";
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    toRequest(req, origin)
      .then(handle)
      .then((r) => send(res, r, cors))
      .catch((err: unknown) => {
        console.error(err);
        res.writeHead(500, cors);
        res.end(String(err));
      });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { close: () => new Promise((resolve) => server.close(() => resolve())) };
}
