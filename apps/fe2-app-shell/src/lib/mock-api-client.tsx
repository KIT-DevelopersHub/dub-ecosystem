// Built-in offline transport for the composed shell (design 2-4 dev path).
//
// The real api-client (api-client.tsx) is wired to the prod gateway
// (VITE_API_BASE_URL / api.developershub.jp). To run the *assembled* shell with
// no backend — local UI work, CI smoke, Storybook-less demos — we swap only the
// transport, MSW-style: a mock `fetch` that answers the shell's boot surface
// (/me, /bff/home, /auth/*) from in-memory seed data. Everything above transport
// (session cookie semantics, 401→refresh, requestId, GET retry, error
// normalization) stays the *real* code path, so the mock exercises the client
// rather than replacing it.
//
// Scope: the shell boot + dashboard surface. Unknown routes resolve to a normal
// 404 error envelope so feature screens render their own in-frame fallbacks
// (never a white screen). Extend `routes`/seed via options to cover more.
import type { ErrorResponse } from "@dub/errors";
import type { gateway, mail } from "@dub/types";

export interface MockSeed {
  me: gateway.MeResponse;
  home: gateway.BffHomeResponse;
}

const DEFAULT_SEED: MockSeed = {
  me: {
    user: { id: "usr_demo", displayName: "デモ ユーザー", avatarUrl: null },
    orgId: "org_demo",
    // Broad-but-not-admin permission set so the primary nav + self-service
    // routes render under the mock. Matches PERMISSION_CATALOG keys.
    permissions: [
      "identity:read",
      "event:read",
      "event:write",
      "task:read",
      "task:write",
      "file:read",
      "notif:inbox:self",
      "notif:prefs:self",
      "mail:read",
      "chat:create",
    ],
    sessionExpiresAt: Date.now() + 60 * 60 * 1000,
  },
  home: {
    upcomingEvents: [
      { id: "evt_demo_1", title: "北陸ITカンファレンス 2026", phase: "preparing", startsAt: "2026-08-05T01:00:00Z" },
      { id: "evt_demo_2", title: "運営定例ミーティング", phase: "planning", startsAt: "2026-08-12T09:00:00Z" },
    ],
    unreadCount: 2,
    partialErrors: [],
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorEnvelope(code: string, message: string, status: number): Response {
  const body: ErrorResponse = { error: { code, message, retryable: status >= 500 } };
  return json(body, status);
}

// A SMALL, clean mail surface (NOT the "weird demo pile"): one seeded received message
// plus a live Sent folder. POST /mail/outbox appends a sent row that GET /mail/sent
// lists and GET /mail/sent/:id opens, so a compose→send→Sent flow works with no backend.
// Fresh per createMockFetch() (reload resets). No real mail leaves the browser.
function firstLine(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) : oneLine;
}

function createMailMock() {
  const received: mail.MailMessageDetail[] = [
    {
      id: "msg_seed_1",
      messageId: "<seed-1@developershub.jp>",
      threadId: "thr_seed_1",
      from: { email: "hanako@example.com", name: "山田 花子" },
      to: [{ email: "demo@developershub.jp" }],
      subject: "登壇のご相談",
      snippet: "カンファレンスでの登壇について相談させてください。",
      receivedAt: "2026-08-02T01:30:00.000Z",
      read: false,
      textBody: "お世話になっております。山田です。\n\nカンファレンスでの登壇について相談させてください。",
    },
  ];
  const sent: mail.MailSentDetail[] = [];
  let seq = 0;

  function handle(method: string, pathname: string, body: unknown): Response | null {
    // received list / detail / read
    if (method === "GET" && pathname === "/api/v1/mail/messages") {
      const items: mail.MailMessageListItem[] = received.map(({ textBody, htmlBody, ...li }) => {
        void textBody;
        void htmlBody;
        return li;
      });
      return json({ items, nextCursor: null });
    }
    {
      const m = /^\/api\/v1\/mail\/messages\/([^/]+)$/.exec(pathname);
      if (m && method === "GET") {
        const found = received.find((r) => r.id === decodeURIComponent(m[1]!));
        return found ? json(found) : errorEnvelope("NOT_FOUND", "message not found", 404);
      }
    }
    if (method === "POST" && /^\/api\/v1\/mail\/messages\/([^/]+)\/read$/.test(pathname)) {
      const id = /messages\/([^/]+)\/read$/.exec(pathname)![1]!;
      const found = received.find((r) => r.id === decodeURIComponent(id));
      if (found) found.read = true;
      return json({ read: true });
    }
    // sent: outbox append + list + detail
    if (method === "POST" && pathname === "/api/v1/mail/outbox") {
      const req = (body ?? {}) as Partial<mail.SendMailRequest>;
      const id = `sent_mock_${Date.now().toString(36)}_${seq++}`;
      const sentAt = new Date().toISOString();
      const providerMessageId = `<mock-${Date.now()}@developershub.jp>`;
      const detail: mail.MailSentDetail = {
        id,
        from: { email: "demo@developershub.jp", name: "デモ ユーザー" },
        to: req.to ?? [],
        ...(req.cc && req.cc.length > 0 ? { cc: req.cc } : {}),
        subject: req.subject ?? "(件名なし)",
        snippet: firstLine(req.textBody ?? ""),
        sentAt,
        provider: "resend",
        providerMessageId,
        status: "sent",
        textBody: req.textBody ?? "",
        ...(req.htmlBody ? { htmlBody: req.htmlBody } : {}),
      };
      sent.unshift(detail);
      const res: mail.SendMailResponse = { messageId: providerMessageId, provider: "resend", acceptedAt: sentAt };
      return json(res);
    }
    if (method === "GET" && pathname === "/api/v1/mail/sent") {
      const items: mail.MailSentListItem[] = sent.map(({ textBody, htmlBody, ...li }) => {
        void textBody;
        void htmlBody;
        return li;
      });
      return json({ items, nextCursor: null });
    }
    {
      const m = /^\/api\/v1\/mail\/sent\/([^/]+)$/.exec(pathname);
      if (m && method === "GET") {
        const found = sent.find((s) => s.id === decodeURIComponent(m[1]!));
        return found ? json(found) : errorEnvelope("NOT_FOUND", "sent message not found", 404);
      }
    }
    return null;
  }

  return { handle };
}

/** A `fetch` implementation that serves the shell's boot surface from seed data.
 *  Feed it to createApiClient({ fetchImpl }). Only the transport is mocked; the
 *  api-client's retry/refresh/error handling runs unchanged. */
export function createMockFetch(seed: Partial<MockSeed> = {}): typeof fetch {
  const data: MockSeed = { me: seed.me ?? DEFAULT_SEED.me, home: seed.home ?? DEFAULT_SEED.home };
  const mailMock = createMailMock();

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const { pathname } = new URL(url);
    const route = `${method} ${pathname}`;

    // Mail (received + Sent folder) served from an in-memory clean seed + sent store.
    if (pathname.startsWith("/api/v1/mail/")) {
      let parsed: unknown;
      if (typeof init?.body === "string" && init.body.length > 0) {
        try {
          parsed = JSON.parse(init.body);
        } catch {
          parsed = undefined;
        }
      }
      const hit = mailMock.handle(method, pathname, parsed);
      if (hit) return hit;
    }

    switch (route) {
      case "GET /api/v1/me":
        return json(data.me);
      case "GET /api/v1/bff/home":
        return json(data.home);
      case "POST /api/v1/auth/refresh":
        return json({}, 200);
      case "POST /api/v1/auth/logout":
        return json(null, 204);
      // Self password change (#5b): acknowledge so the demo/offline build shows success.
      case "POST /api/v1/me/password":
        return json({ ok: true }, 200);
      // Feedback widget (shell chrome): acknowledge so the offline/demo build shows
      // the success state. No real feedback leaves the browser under the mock.
      case "POST /api/v1/feedback":
        return json({ id: `fb_demo_${Date.now()}` }, 201);
      default:
        // Unhandled by the boot mock: a normal NOT_FOUND envelope so feature
        // screens surface their own in-frame fallback (design 2-1).
        return errorEnvelope("NOT_FOUND", `mock: no handler for ${route}`, 404);
    }
  };

  return mockFetch as unknown as typeof fetch;
}

/** True when the shell should boot against the built-in offline mock transport. */
export function isMockEnabled(env: { VITE_API_MOCK?: string } | undefined): boolean {
  return env?.VITE_API_MOCK === "true" || env?.VITE_API_MOCK === "1";
}
