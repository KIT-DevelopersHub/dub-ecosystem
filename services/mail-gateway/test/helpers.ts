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
    ...over,
  };
}

export function inboundDeps(h: Harness, over: Partial<InboundDeps> = {}): InboundDeps {
  return {
    db: h.db,
    events: h.events,
    audit: h.audit,
    orgId: "org_devhub",
    ctx: ctx("req_in"),
    ...over,
  };
}

// ---- fake identity Fetcher (POST /authz/check) for app-level auth tests ----
export function fakeIdentityFetcher(allow: boolean): Fetcher {
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/authz/check") {
        const body = (await req.json()) as identity.AuthzCheckRequest;
        const res: identity.AuthzCheckResponse = {
          decisions: body.checks.map(() => ({ allowed: allow, evaluatedAt: new Date().toISOString(), ttlSeconds: 60 })),
        };
        return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
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
