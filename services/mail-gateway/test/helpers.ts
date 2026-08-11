// Shared test scaffolding: in-memory D1, recording queues, a fake identity Fetcher for
// authz, and ready-made SendDeps / InboundDeps. Keeps each test focused on behaviour.
import { createDbClient, type DbClient } from "@dub/db";
import type { RequestContext } from "@dub/http";
import type { AuditRecordEnvelopeV1, DubEventEnvelope } from "@dub/events";
import type { Queue, Fetcher } from "@cloudflare/workers-types";
import type { identity } from "@dub/types";
import type { Env } from "../src/env";
import type { AuditEnv, EventPublishEnv, InboundDeps, SendDeps } from "../src/types";
import { MockMailProvider } from "../src/provider";
import { makeD1 } from "./d1";

export interface RecordingQueue<T> {
  queue: Queue<T>;
  sends: T[];
}
export function recordingQueue<T>(): RecordingQueue<T> {
  const sends: T[] = [];
  const queue = {
    async send(msg: T) {
      sends.push(msg);
    },
    async sendBatch(batch: Iterable<{ body: T }>) {
      for (const m of batch) sends.push(m.body);
    },
  } as unknown as Queue<T>;
  return { queue, sends };
}

export function ctx(requestId = "req_test", userId?: string): RequestContext {
  return { requestId, caller: "test-caller", ...(userId ? { userId } : {}) };
}

export interface Harness {
  db: DbClient;
  events: EventPublishEnv;
  audit: AuditEnv;
  mailAuto: RecordingQueue<DubEventEnvelope>;
  notif: RecordingQueue<DubEventEnvelope>;
  auditQ: RecordingQueue<AuditRecordEnvelopeV1>;
  provider: MockMailProvider;
  raw: ReturnType<typeof makeD1>["raw"];
}

export function makeHarness(providerOpts: { fail?: boolean; rateLimit?: boolean } = {}): Harness {
  const { d1, raw } = makeD1();
  const db = createDbClient(d1, { namespace: "mail" });
  const mailAuto = recordingQueue<DubEventEnvelope>();
  const notif = recordingQueue<DubEventEnvelope>();
  const auditQ = recordingQueue<AuditRecordEnvelopeV1>();
  return {
    db,
    events: { EVT_MAIL_AUTOMATION: mailAuto.queue, EVT_NOTIFICATION: notif.queue },
    audit: { AUDIT_QUEUE: auditQ.queue },
    mailAuto,
    notif,
    auditQ,
    provider: new MockMailProvider(providerOpts),
    raw,
  };
}

export function sendDeps(h: Harness, over: Partial<SendDeps> = {}): SendDeps {
  return {
    db: h.db,
    provider: h.provider,
    events: h.events,
    audit: h.audit,
    orgId: "org_devhub",
    fromAddress: "info@developershub.jp",
    ctx: ctx("req_send", "usr_alice"),
    ownerUserId: "usr_alice",
    ...over,
  };
}

// Default recipient→owner mapping for inbound tests: info@developershub.jp resolves to
// the roster user usr_info, so an ingested message is owned (Inbox scope) and visible to
// a listInbound({ ownerUserId: "usr_info" }). Override `identity` to test other mappings.
export function inboundDeps(h: Harness, over: Partial<InboundDeps> = {}): InboundDeps {
  return {
    db: h.db,
    events: h.events,
    audit: h.audit,
    orgId: "org_devhub",
    ctx: ctx("req_in"),
    identity: fakeIdentityFetcher(true, { usr_info: { email: "info@developershub.jp" } }),
    ...over,
  };
}

// ---- fake identity Fetcher (POST /authz/check) for app-level auth tests ----
// `users` (optional) also answers the internal GET /users/:id used by the outbox From
// resolution: a userId present here resolves to that roster user (email drives the
// From); a userId absent from the map 404s (→ safe info@ fallback). It also answers the
// internal POST /internal/users/lookup { email } used by inbound owner resolution: an
// email present in the map resolves to { user }, any other email to { user: null }.
export function fakeIdentityFetcher(
  allow: boolean,
  users: Record<string, { email: string; displayName?: string }> = {},
): Fetcher {
  const toIdentityUser = (id: string, email: string, displayName?: string): identity.IdentityUser => ({
    id,
    orgId: "org_devhub",
    displayName: displayName ?? email,
    email,
    githubLogin: null,
    avatarUrl: null,
    status: "active",
    roleIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/internal/users/lookup" && req.method === "POST") {
        const body = (await req.json()) as { email?: string };
        const wanted = (body.email ?? "").trim().toLowerCase();
        const match = Object.entries(users).find(([, u]) => u.email.trim().toLowerCase() === wanted);
        const user = match ? toIdentityUser(match[0], match[1].email, match[1].displayName) : null;
        return new Response(JSON.stringify({ user }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/authz/check") {
        const body = (await req.json()) as identity.AuthzCheckRequest;
        const res: identity.AuthzCheckResponse = {
          decisions: body.checks.map(() => ({ allowed: allow, evaluatedAt: new Date().toISOString(), ttlSeconds: 60 })),
        };
        return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
      }
      const userMatch = /^\/users\/([^/]+)$/.exec(url.pathname);
      if (userMatch && req.method === "GET") {
        const id = decodeURIComponent(userMatch[1]!);
        const seed = users[id];
        if (!seed) return new Response("not found", { status: 404 });
        const user: identity.IdentityUser = {
          id,
          orgId: "org_devhub",
          displayName: seed.displayName ?? seed.email,
          email: seed.email,
          githubLogin: null,
          avatarUrl: null,
          status: "active",
          roleIds: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        return new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
}

// A Fetcher that must never be called (routes that do not touch identity).
export const inertFetcher = {
  async fetch() {
    throw new Error("unexpected identity fetch");
  },
} as unknown as Fetcher;

export function makeEnv(overrides: Partial<Env> = {}): { env: Env; raw: ReturnType<typeof makeD1>["raw"]; sends: { mailAuto: DubEventEnvelope[]; notif: DubEventEnvelope[]; audit: AuditRecordEnvelopeV1[] } } {
  const { d1, raw } = makeD1();
  const mailAuto = recordingQueue<DubEventEnvelope>();
  const notif = recordingQueue<DubEventEnvelope>();
  const auditQ = recordingQueue<AuditRecordEnvelopeV1>();
  const env: Env = {
    DB: d1,
    AUDIT_QUEUE: auditQ.queue,
    EVT_MAIL_AUTOMATION: mailAuto.queue,
    EVT_NOTIFICATION: notif.queue,
    SVC_IDENTITY: fakeIdentityFetcher(true),
    MAIL_OUTBOUND_PROVIDER: "mock",
    ...overrides,
  };
  return { env, raw, sends: { mailAuto: mailAuto.sends, notif: notif.sends, audit: auditQ.sends } };
}
